import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from "typeorm";

@Entity("roles")
@Unique("uq_roles_name", ["name"])
@Check("chk_roles_name", `"name" ~ '^[a-z][a-z0-9._-]{0,63}$'`)
export class Role {
  @PrimaryGeneratedColumn("uuid", { primaryKeyConstraintName: "pk_roles" })
  id: string;

  @Column({ type: "varchar", length: 64 })
  name: string;

  @Column({ type: "varchar", length: 500, nullable: true })
  description: string | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt: Date;
}
