import { Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { authorizationUnavailable } from "../../../common/errors/authorization-unavailable";
import { POLICY_STATE_ID, RbacPolicyState } from "../entities/rbac-policy-state.entity";

export interface RbacDecision {
  allowed: boolean;
  version: number;
}

interface PolicySnapshot {
  version: number;
  rights: Map<string, Set<string>>;
}

interface RightRow {
  user_id: string;
  permission: string;
  action: string;
}

const RIGHTS_QUERY = `
  SELECT ur."user_id", p."name" AS "permission", pa."name" AS "action"
  FROM "user_roles" ur
  JOIN "grants" g ON g."role_id" = ur."role_id"
  JOIN "permissions" p ON p."id" = g."permission_id"
  JOIN "permission_actions" pa ON pa."permission_id" = g."permission_id"
  WHERE g."all_actions"
    OR EXISTS (
      SELECT 1 FROM "grant_actions" ga
      WHERE ga."grant_id" = g."id" AND ga."permission_action_id" = pa."id"
    )
`;

@Injectable()
export class RbacPolicyService implements OnApplicationBootstrap {
  private readonly logger = new Logger(RbacPolicyService.name);
  private snapshot: PolicySnapshot | null = null;
  private loading: Promise<PolicySnapshot> | null = null;

  constructor(
    @InjectRepository(RbacPolicyState)
    private readonly policyRepository: Repository<RbacPolicyState>,
  ) {}

  public async onApplicationBootstrap() {
    try {
      await this.reload();
    } catch {
    }
  }

  public get ready() {
    return this.snapshot !== null;
  }

  public async checkReady() {
    if (this.snapshot) {
      return true;
    }
    try {
      await this.reload();
      return true;
    } catch {
      return false;
    }
  }

  public async authorize(
    userId: string,
    permission: string,
    action: string,
  ): Promise<RbacDecision> {
    const snapshot = await this.snapshotFor(await this.currentVersion());
    return {
      allowed: snapshot.rights.get(userId)?.has(`${permission}@${action}`) ?? false,
      version: snapshot.version,
    };
  }

  private async currentVersion() {
    let state: Pick<RbacPolicyState, "version"> | null;
    try {
      state = await this.policyRepository.findOne({
        where: { id: POLICY_STATE_ID },
        select: { version: true },
      });
    } catch (error) {
      this.logger.error(
        `Authorization unavailable reason=rbac_version: ${(error as Error).message}`,
      );
      throw authorizationUnavailable();
    }
    if (!state) {
      this.logger.error("Authorization unavailable reason=rbac_version: state row is missing");
      throw authorizationUnavailable();
    }
    return state.version;
  }

  private async snapshotFor(version: number) {
    let snapshot = this.snapshot;
    if (!snapshot || snapshot.version < version) {
      snapshot = await this.reload();
    }
    if (snapshot.version < version) {
      snapshot = await this.reload();
    }
    return snapshot;
  }

  private reload() {
    this.loading ??= this.load().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  private async load(): Promise<PolicySnapshot> {
    try {
      const snapshot = await this.policyRepository.manager.transaction(
        "REPEATABLE READ",
        async (manager) => {
          const state = await manager.findOneOrFail(RbacPolicyState, {
            where: { id: POLICY_STATE_ID },
          });
          const rows: RightRow[] = await manager.query(RIGHTS_QUERY);
          return { version: state.version, rights: groupRights(rows) };
        },
      );
      this.snapshot = snapshot;
      this.logger.log(
        `RBAC snapshot loaded version=${snapshot.version} users=${snapshot.rights.size}`,
      );
      return snapshot;
    } catch (error) {
      this.snapshot = null;
      this.logger.error(
        `Authorization unavailable reason=rbac_snapshot: ${(error as Error).message}`,
      );
      throw authorizationUnavailable();
    }
  }
}

function groupRights(rows: RightRow[]) {
  const rights = new Map<string, Set<string>>();
  for (const row of rows) {
    let userRights = rights.get(row.user_id);
    if (!userRights) {
      userRights = new Set();
      rights.set(row.user_id, userRights);
    }
    userRights.add(`${row.permission}@${row.action}`);
  }
  return rights;
}
