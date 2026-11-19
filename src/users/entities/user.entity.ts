import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from "typeorm";

export type UserStatus =
  | "pending"
  | "active"
  | "blocked"
  | "deleting"
  | "deleted";

@Entity("users")
@Unique("uq_users_photo_key", ["photoKey"])
export class User {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "varchar", length: 255, unique: true })
  email: string;

  @Column({ name: "display_name", type: "varchar", length: 80, nullable: true })
  displayName: string | null;

  @Column({ name: "photo_key", type: "varchar", length: 255, nullable: true })
  photoKey: string | null;

  @Column({ type: "varchar", length: 20 })
  status: UserStatus;

  @Column({ name: "password_hash", type: "varchar", length: 250 })
  passwordHash: string;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt: Date;
}
