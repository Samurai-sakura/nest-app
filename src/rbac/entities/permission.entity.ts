import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  OneToMany,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from "typeorm";
import { PermissionAction } from "./permission-action.entity";

@Entity("permissions")
@Unique("uq_permissions_name", ["name"])
@Check("chk_permissions_name", `"name" ~ '^[a-z][a-z0-9._-]{0,63}$'`)
export class Permission {
  @PrimaryGeneratedColumn("uuid", { primaryKeyConstraintName: "pk_permissions" })
  id: string;

  @Column({ type: "varchar", length: 64 })
  name: string;

  @Column({ type: "varchar", length: 500, nullable: true })
  description: string | null;

  @OneToMany(() => PermissionAction, (action) => action.permission)
  actions: PermissionAction[];

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt: Date;
}
