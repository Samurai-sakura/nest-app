import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { RbacPolicyService } from "../access-control/rbac/services/rbac-policy.service";
import { RouteConfigurationService } from "../access-control/authorization/services/route-configuration.service";

const JWT_KEYS = ["JWT_ACCESS_SECRET", "JWT_REFRESH_SECRET"];

export type ReadinessCheck = "database" | "rbac_snapshot" | "route_configuration" | "jwt_keys";

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly rbac: RbacPolicyService,
    private readonly routes: RouteConfigurationService,
    private readonly config: ConfigService,
  ) {}

  // имена проваленных проверок только в журнале: наружу readiness отвечает без подробностей
  public async failedChecks(): Promise<ReadinessCheck[]> {
    const checks: Record<ReadinessCheck, boolean> = {
      database: await this.databaseReachable(),
      rbac_snapshot: await this.rbac.checkReady(),
      route_configuration: this.routes.ready,
      jwt_keys: JWT_KEYS.every((key) => Boolean(this.config.get<string>(key))),
    };
    const failed = (Object.keys(checks) as ReadinessCheck[]).filter((name) => !checks[name]);
    if (failed.length > 0) {
      this.logger.warn(`Readiness failed checks=${failed.join(",")}`);
    }
    return failed;
  }

  private async databaseReachable() {
    try {
      await this.dataSource.query("SELECT 1");
      return true;
    } catch (error) {
      this.logger.error(`Readiness database check failed: ${(error as Error).message}`);
      return false;
    }
  }
}
