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
import { PermissionBodyDto, PermissionResponse } from "../dto/permission.dto";
import { PermissionsService } from "../services/permissions.service";

@ApiTags("RBAC Permissions")
@RequirePermission("rbac", "manage")
@UseInterceptors(RbacAuditInterceptor)
@Controller("admin/rbac/permissions")
export class PermissionsController {
  constructor(private readonly permissionsService: PermissionsService) {}

  @Get()
  @ApiOperation({ summary: "Список разрешений с действиями" })
  @ApiOkResponse({ type: [PermissionResponse] })
  public list() {
    return this.permissionsService.list();
  }

  @Post()
  @ApiOperation({ summary: "Создание разрешения с набором действий" })
  @ApiCreatedResponse({ type: PermissionResponse })
  @ApiBadRequestResponse({ description: "Невалидные имя, описание или действия", type: ErrorResponse })
  @ApiConflictResponse({ description: "name_taken", type: ErrorResponse })
  public create(@CurrentUserId() actorUserId: string, @Body() dto: PermissionBodyDto) {
    return this.permissionsService.create(actorUserId, dto);
  }

  @Put(":permissionId")
  @ApiOperation({
    summary: "Замена разрешения и всего набора действий",
    description:
      "Удалить действие, перечисленное в конкретном назначении, нельзя. Назначения всех действий охватывают только оставшиеся и новые действия.",
  })
  @ApiOkResponse({ type: PermissionResponse })
  @ApiBadRequestResponse({ description: "Невалидные id, имя, описание или действия", type: ErrorResponse })
  @ApiNotFoundResponse({ description: "permission_not_found", type: ErrorResponse })
  @ApiConflictResponse({
    description: "name_taken, action_in_use или last_rbac_manager",
    type: ErrorResponse,
  })
  public replace(
    @CurrentUserId() actorUserId: string,
    @Param("permissionId", ParseUUIDPipe) permissionId: string,
    @Body() dto: PermissionBodyDto,
  ) {
    return this.permissionsService.replace(actorUserId, permissionId, dto);
  }

  @Delete(":permissionId")
  @HttpCode(204)
  @ApiOperation({ summary: "Удаление разрешения без назначений" })
  @ApiNoContentResponse({ description: "Разрешение удалено вместе с действиями" })
  @ApiNotFoundResponse({ description: "permission_not_found", type: ErrorResponse })
  @ApiConflictResponse({ description: "in_use: разрешение назначено ролям", type: ErrorResponse })
  public async remove(
    @CurrentUserId() actorUserId: string,
    @Param("permissionId", ParseUUIDPipe) permissionId: string,
  ) {
    await this.permissionsService.remove(actorUserId, permissionId);
  }
}
