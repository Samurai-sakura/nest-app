import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from "typeorm";
import { Role } from "./role.entity";
import { Permission } from "./permission.entity";
import { GrantAction } from "./grant-action.entity";

// allActions=true охватывает и действия, добавленные позже; тогда grant_actions пуст
@Entity("grants")
@Unique("uq_grants_role_permission", ["roleId", "permissionId"])
@Unique("uq_grants_id_permission", ["id", "permissionId"])
@Index("idx_grants_permission", ["permissionId"])
export class Grant {
  @PrimaryGeneratedColumn("uuid", { primaryKeyConstraintName: "pk_grants" })
  id: string;

  @Column({ name: "role_id", type: "uuid" })
  roleId: string;

  @ManyToOne(() => Role, { onDelete: "RESTRICT" })
  @JoinColumn({ name: "role_id", foreignKeyConstraintName: "fk_grants_role" })
  role: Role;

  @Column({ name: "permission_id", type: "uuid" })
  permissionId: string;

  @ManyToOne(() => Permission, { onDelete: "RESTRICT" })
  @JoinColumn({
    name: "permission_id",
    foreignKeyConstraintName: "fk_grants_permission",
  })
  permission: Permission;

  @Column({ name: "all_actions", type: "boolean", default: false })
  allActions: boolean;

  @OneToMany(() => GrantAction, (action) => action.grant)
  actions: GrantAction[];

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt: Date;
}
