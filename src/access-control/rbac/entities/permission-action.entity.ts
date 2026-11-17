import {
  Check,
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from "typeorm";
import { Permission } from "./permission.entity";

@Entity("permission_actions")
@Unique("uq_permission_actions_permission_name", ["permissionId", "name"])
@Unique("uq_permission_actions_id_permission", ["id", "permissionId"])
@Check("chk_permission_actions_name", `"name" ~ '^[a-z][a-z0-9._-]{0,63}$'`)
export class PermissionAction {
  @PrimaryGeneratedColumn("uuid", { primaryKeyConstraintName: "pk_permission_actions" })
  id: string;

  @Column({ name: "permission_id", type: "uuid" })
  permissionId: string;

  @ManyToOne(() => Permission, (permission) => permission.actions, {
    onDelete: "CASCADE",
  })
  @JoinColumn({
    name: "permission_id",
    foreignKeyConstraintName: "fk_permission_actions_permission",
  })
  permission: Permission;

  @Column({ type: "varchar", length: 64 })
  name: string;
}
