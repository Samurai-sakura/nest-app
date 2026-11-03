import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from "typeorm";
import { User } from "./user.entity";

export type ConfirmationMethod = "otp" | "magic_link";

@Entity("registration_confirmations")
@Index("uq_confirmation_active_user", ["userId"], {
  unique: true,
  where: `"consumed_at" IS NULL`,
})
export class RegistrationConfirmation {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ name: "user_id", type: "uuid" })
  userId: string;

  @ManyToOne(() => User, { onDelete: "CASCADE" })
  @JoinColumn({ name: "user_id" })
  user: User;

  @Column({ type: "varchar", length: 20 })
  method: ConfirmationMethod;

  @Index("idx_confirmation_secret_hash")
  @Column({ name: "secret_hash", type: "varchar", length: 64 })
  secretHash: string;

  @Column({ name: "failed_attempts", type: "int", default: 0 })
  failedAttempts: number;

  @Column({ name: "expires_at", type: "timestamptz" })
  expiresAt: Date;

  @Column({ name: "last_sent_at", type: "timestamptz", nullable: true })
  lastSentAt: Date | null;

  @Column({ name: "consumed_at", type: "timestamptz", nullable: true })
  consumedAt: Date | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;
}
