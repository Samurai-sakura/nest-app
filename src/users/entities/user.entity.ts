import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

export type UserStatus =
  | "pending"
  | "active"
  | "blocked"
  | "deleting"
  | "deleted";

@Entity("users")
export class User {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "varchar", length: 255, unique: true })
  email: string;

  @Column({ type: "varchar", length: 250, nullable: true })
  name: string | null;

  @Column({ type: "varchar", length: 20 })
  status: UserStatus;

  @Column({ name: "password_hash", type: "varchar", length: 250 })
  passwordHash: string;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt: Date;
}
