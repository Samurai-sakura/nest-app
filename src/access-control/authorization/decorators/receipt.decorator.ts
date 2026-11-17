import { SetMetadata } from "@nestjs/common";
import { RECEIPT_KEY } from "../helpers/route-declaration";

// при наличии заголовка access и RBAC не запускаются, квитанцию проверяет обработчик.
// Вместе с @RequirePermission() запрос без заголовка идёт по обычной цепочке
export const Receipt = (header: string) => SetMetadata(RECEIPT_KEY, header.toLowerCase());
