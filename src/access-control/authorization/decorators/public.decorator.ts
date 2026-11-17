import { SetMetadata } from "@nestjs/common";
import { PUBLIC_KEY } from "../helpers/route-declaration";

export const Public = () => SetMetadata(PUBLIC_KEY, true);
