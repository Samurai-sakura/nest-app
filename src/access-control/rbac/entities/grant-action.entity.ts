import { Entity, Index, JoinColumn, ManyToOne, PrimaryColumn } from "typeorm";
import { Grant } from "./grant.entity";
import { PermissionAction } from "./permission-action.entity";

@Entity("grant_actions")
@Index("idx_grant_actions_action", ["permissionActionId"])
export class GrantAction {
  @PrimaryColumn({
    name: "grant_id",
    type: "uuid",
    primaryKeyConstraintName: "pk_grant_actions",
  })
  grantId: string;

  @PrimaryColumn({
    name: "permission_action_id",
    type: "uuid",
    primaryKeyConstraintName: "pk_grant_actions",
  })
  permissionActionId: string;

  @ManyToOne(() => Grant, (grant) => grant.actions, { onDelete: "CASCADE" })
  @JoinColumn({ name: "grant_id", foreignKeyConstraintName: "fk_grant_actions_grant" })
  grant: Grant;

  @ManyToOne(() => PermissionAction, { onDelete: "RESTRICT" })
  @JoinColumn({
    name: "permission_action_id",
    foreignKeyConstraintName: "fk_grant_actions_action",
  })
  permissionAction: PermissionAction;
}
