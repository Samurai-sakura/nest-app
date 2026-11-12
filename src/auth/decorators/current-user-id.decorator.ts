import { createParamDecorator, ExecutionContext } from "@nestjs/common";
import type { AuthenticatedRequest } from "../guards/access.guard";

export const CurrentUserId = createParamDecorator(
  (_data: unknown, context: ExecutionContext) => {
    const { userId } = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!userId) {
      throw new Error("@CurrentUserId() requires AccessGuard on the route");
    }
    return userId;
  },
);
