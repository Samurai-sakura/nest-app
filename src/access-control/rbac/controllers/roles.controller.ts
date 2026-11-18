import {
  Body,
  UseInterceptors,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
} from "@nestjs/common";
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from "@nestjs/swagger";
import { RequirePermission } from "../../authorization/decorators/require-permission.decorator";
import { CurrentUserId } from "../../authorization/decorators/current-user-id.decorator";
import { RbacAuditInterceptor } from "../helpers/rbac-audit.interceptor";
import { ErrorResponse } from "../../../common/dto/error-response.dto";
import { RoleBodyDto, RoleResponse } from "../dto/role.dto";
import { RolesService } from "../services/roles.service";

@ApiTags("RBAC Roles")
@RequirePermission("rbac", "manage")
@UseInterceptors(RbacAuditInterceptor)
@Controller("admin/rbac/roles")
export class RolesController {
  constructor(private readonly rolesService: RolesService) {}

  @Get()
  @ApiOperation({ summary: "Список ролей" })
  @ApiOkResponse({ type: [RoleResponse] })
  public list() {
    return this.rolesService.list();
  }

  @Post()
  @ApiOperation({ summary: "Создание роли" })
  @ApiCreatedResponse({ type: RoleResponse })
  @ApiBadRequestResponse({ description: "Невалидные имя или описание", type: ErrorResponse })
  @ApiConflictResponse({ description: "name_taken: имя занято", type: ErrorResponse })
  public create(@CurrentUserId() actorUserId: string, @Body() dto: RoleBodyDto) {
    return this.rolesService.create(actorUserId, dto);
  }

  @Put(":roleId")
  @ApiOperation({ summary: "Замена имени и описания роли" })
  @ApiOkResponse({ type: RoleResponse })
  @ApiBadRequestResponse({ description: "Невалидные id, имя или описание", type: ErrorResponse })
  @ApiNotFoundResponse({ description: "role_not_found", type: ErrorResponse })
  @ApiConflictResponse({ description: "name_taken", type: ErrorResponse })
  public replace(
    @CurrentUserId() actorUserId: string,
    @Param("roleId", ParseUUIDPipe) roleId: string,
    @Body() dto: RoleBodyDto,
  ) {
    return this.rolesService.replace(actorUserId, roleId, dto);
  }

  @Delete(":roleId")
  @HttpCode(204)
  @ApiOperation({ summary: "Удаление роли без назначений и пользователей" })
  @ApiNoContentResponse({ description: "Роль удалена" })
  @ApiNotFoundResponse({ description: "role_not_found", type: ErrorResponse })
  @ApiConflictResponse({ description: "in_use: у роли есть назначения или пользователи", type: ErrorResponse })
  public async remove(
    @CurrentUserId() actorUserId: string,
    @Param("roleId", ParseUUIDPipe) roleId: string,
  ) {
    await this.rolesService.remove(actorUserId, roleId);
  }
}
