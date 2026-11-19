import { SetMetadata } from "@nestjs/common";
import { RECEIPT_KEY } from "../helpers/route-declaration";

export const Receipt = (header: string) => SetMetadata(RECEIPT_KEY, header.toLowerCase());
