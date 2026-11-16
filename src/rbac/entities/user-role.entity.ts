import { Entity, Index, JoinColumn, ManyToOne, PrimaryColumn } from "typeorm";
import { User } from "../../auth/entities/user.entity";
import { Role } from "./role.entity";

@Entity("user_roles")
@Index("idx_user_roles_role", ["roleId"])
export class UserRole {
  @PrimaryColumn({
    name: "user_id",
    type: "uuid",
    primaryKeyConstraintName: "pk_user_roles",
  })
  userId: string;

  @PrimaryColumn({
    name: "role_id",
    type: "uuid",
    primaryKeyConstraintName: "pk_user_roles",
  })
  roleId: string;

  @ManyToOne(() => User, { onDelete: "CASCADE" })
  @JoinColumn({ name: "user_id", foreignKeyConstraintName: "fk_user_roles_user" })
  user: User;

  @ManyToOne(() => Role, { onDelete: "RESTRICT" })
  @JoinColumn({ name: "role_id", foreignKeyConstraintName: "fk_user_roles_role" })
  role: Role;
}
