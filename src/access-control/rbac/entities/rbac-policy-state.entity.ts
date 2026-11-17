import { Check, Column, Entity, PrimaryColumn, UpdateDateColumn } from "typeorm";

export const POLICY_STATE_ID = 1;

// единственная строка; version увеличивают триггеры миграции в той же транзакции,
// что и любое изменение RBAC: сервису менять её не нужно
@Entity("rbac_policy_state")
@Check("chk_rbac_policy_state_single_row", `"id" = 1`)
@Check("chk_rbac_policy_state_version", `"version" >= 0`)
export class RbacPolicyState {
  @PrimaryColumn({
    type: "smallint",
    primaryKeyConstraintName: "pk_rbac_policy_state",
  })
  id: number;

  @Column({ type: "integer" })
  version: number;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt: Date;
}
