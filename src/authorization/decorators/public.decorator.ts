import { SetMetadata } from "@nestjs/common";
import { PUBLIC_KEY } from "../route-declaration";

export const Public = () => SetMetadata(PUBLIC_KEY, true);
