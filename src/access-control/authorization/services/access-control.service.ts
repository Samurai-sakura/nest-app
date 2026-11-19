import { Injectable, Logger } from "@nestjs/common";
import { ownershipDenied, permissionDenied } from "../helpers/authorization-errors";
import { RbacPolicyService } from "../../rbac/services/rbac-policy.service";
import type { RequiredPermission } from "../helpers/route-declaration";

export interface OwnedResource {
  id: string;
  ownerId: string | null;
}

@Injectable()
export class AccessControlService {
  private readonly logger = new Logger(AccessControlService.name);

  constructor(private readonly rbac: RbacPolicyService) {}

  public async requirePermission(userId: string, permission: string, action: string) {
    const { allowed, version } = await this.rbac.authorize(userId, permission, action);
    if (!allowed) {
      this.logger.warn(
        `Request rejected reason=permission_denied actorUserId=${userId} required=${permission}@${action} policyVersion=${version}`,
      );
      throw permissionDenied();
    }
  }

  public async requireOwner(userId: string, resource: OwnedResource, any?: RequiredPermission) {
    if (resource.ownerId === userId) {
      return;
    }
    if (any && (await this.rbac.authorize(userId, any.permission, any.action)).allowed) {
      return;
    }
    this.logger.warn(
      `Request rejected reason=ownership_denied actorUserId=${userId} resourceId=${resource.id}`,
    );
    throw ownershipDenied();
  }
}
