import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn } from "typeorm";
import { Grant } from "./grant.entity";
import { PermissionAction } from "./permission-action.entity";

// permission_id входит в оба составных FK: действие должно принадлежать разрешению назначения
@Entity("grant_actions")
@Index("idx_grant_actions_action", ["permissionActionId", "permissionId"])
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

  @Column({ name: "permission_id", type: "uuid" })
  permissionId: string;

  @ManyToOne(() => Grant, (grant) => grant.actions, { onDelete: "CASCADE" })
  @JoinColumn([
    {
      name: "grant_id",
      referencedColumnName: "id",
      foreignKeyConstraintName: "fk_grant_actions_grant",
    },
    { name: "permission_id", referencedColumnName: "permissionId" },
  ])
  grant: Grant;

  @ManyToOne(() => PermissionAction, { onDelete: "RESTRICT" })
  @JoinColumn([
    {
      name: "permission_action_id",
      referencedColumnName: "id",
      foreignKeyConstraintName: "fk_grant_actions_action",
    },
    { name: "permission_id", referencedColumnName: "permissionId" },
  ])
  permissionAction: PermissionAction;
}
