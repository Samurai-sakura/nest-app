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
import type { ConfirmationMethod } from "../../identity/confirmation-method";

export type EmailChangeConsumedReason =
  | "confirmed"
  | "replaced"
  | "attempts_exhausted"
  | "user_inactive"
  | "admin_override"
  | "email_conflict";

@Entity("email_change_challenges")
@Index("uq_email_change_challenge_active_user", ["userId"], {
  unique: true,
  where: `"consumed_at" IS NULL`,
})
export class EmailChangeChallenge {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ name: "user_id", type: "uuid" })
  userId: string;

  @ManyToOne(() => User, { onDelete: "CASCADE" })
  @JoinColumn({ name: "user_id" })
  user: User;

  @Column({ name: "new_email", type: "varchar", length: 255 })
  newEmail: string;

  @Column({ type: "varchar", length: 20 })
  method: ConfirmationMethod;

  @Column({ name: "secret_hash", type: "varchar", length: 64 })
  secretHash: string;

  @Column({ name: "last_sent_at", type: "timestamptz" })
  lastSentAt: Date;

  @Column({ type: "int", default: 0 })
  attempts: number;

  @Column({ name: "consumed_at", type: "timestamptz", nullable: true })
  consumedAt: Date | null;

  @Column({
    name: "consumed_reason",
    type: "varchar",
    length: 20,
    nullable: true,
  })
  consumedReason: EmailChangeConsumedReason | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt: Date;
}
