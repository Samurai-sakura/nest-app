import { Body, Controller, Get, Param, ParseUUIDPipe, Put } from "@nestjs/common";
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from "@nestjs/swagger";
import { RequirePermission } from "../../authorization/decorators/require-permission.decorator";
import { CurrentUserId } from "../../authorization/decorators/current-user-id.decorator";
import { ErrorResponse } from "../../../common/dto/error-response.dto";
import { UserRolesBodyDto, UserRolesResponse } from "../dto/user-roles.dto";
import { UserRolesService } from "../services/user-roles.service";

@ApiTags("RBAC User Roles")
@RequirePermission("rbac", "manage")
@Controller("admin/rbac/users/:userId/roles")
export class UserRolesController {
  constructor(private readonly userRolesService: UserRolesService) {}

  @Get()
  @ApiOperation({ summary: "Роли пользователя" })
  @ApiOkResponse({ type: UserRolesResponse })
  @ApiBadRequestResponse({ description: "Невалидный userId", type: ErrorResponse })
  @ApiNotFoundResponse({ description: "user_not_found", type: ErrorResponse })
  public get(
    @CurrentUserId() actorUserId: string,
    @Param("userId", ParseUUIDPipe) userId: string,
  ) {
    return this.userRolesService.get(actorUserId, userId);
  }

  @Put()
  @ApiOperation({
    summary: "Полная замена ролей пользователя",
    description: "Пустой массив снимает все роли.",
  })
  @ApiOkResponse({ type: UserRolesResponse })
  @ApiBadRequestResponse({ description: "Невалидные id или повтор роли", type: ErrorResponse })
  @ApiNotFoundResponse({ description: "user_not_found или role_not_found", type: ErrorResponse })
  @ApiConflictResponse({ description: "last_rbac_manager", type: ErrorResponse })
  public replace(
    @CurrentUserId() actorUserId: string,
    @Param("userId", ParseUUIDPipe) userId: string,
    @Body() dto: UserRolesBodyDto,
  ) {
    return this.userRolesService.replace(actorUserId, userId, dto.roleIds);
  }
}
