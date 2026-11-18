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
import { GrantBodyDto, GrantResponse } from "../dto/grant.dto";
import { GrantsService } from "../services/grants.service";

@ApiTags("RBAC Grants")
@RequirePermission("rbac", "manage")
@UseInterceptors(RbacAuditInterceptor)
@Controller("admin/rbac/grants")
export class GrantsController {
  constructor(private readonly grantsService: GrantsService) {}

  @Get()
  @ApiOperation({ summary: "Список назначений разрешений ролям" })
  @ApiOkResponse({ type: [GrantResponse] })
  public list() {
    return this.grantsService.list();
  }

  @Post()
  @ApiOperation({
    summary: "Назначение разрешения роли",
    description: "Отсутствующий или пустой actions — все текущие и будущие действия разрешения.",
  })
  @ApiCreatedResponse({ type: GrantResponse })
  @ApiBadRequestResponse({
    description: "Невалидное тело или unknown_action: действие не принадлежит разрешению",
    type: ErrorResponse,
  })
  @ApiNotFoundResponse({ description: "role_not_found или permission_not_found", type: ErrorResponse })
  @ApiConflictResponse({ description: "grant_exists: пара роли и разрешения уже назначена", type: ErrorResponse })
  public create(@CurrentUserId() actorUserId: string, @Body() dto: GrantBodyDto) {
    return this.grantsService.create(actorUserId, dto);
  }

  @Put(":grantId")
  @ApiOperation({ summary: "Полная замена назначения" })
  @ApiOkResponse({ type: GrantResponse })
  @ApiBadRequestResponse({ description: "Невалидные id или тело, unknown_action", type: ErrorResponse })
  @ApiNotFoundResponse({
    description: "grant_not_found, role_not_found или permission_not_found",
    type: ErrorResponse,
  })
  @ApiConflictResponse({ description: "grant_exists или last_rbac_manager", type: ErrorResponse })
  public replace(
    @CurrentUserId() actorUserId: string,
    @Param("grantId", ParseUUIDPipe) grantId: string,
    @Body() dto: GrantBodyDto,
  ) {
    return this.grantsService.replace(actorUserId, grantId, dto);
  }

  @Delete(":grantId")
  @HttpCode(204)
  @ApiOperation({ summary: "Удаление назначения" })
  @ApiNoContentResponse({ description: "Назначение удалено" })
  @ApiNotFoundResponse({ description: "grant_not_found", type: ErrorResponse })
  @ApiConflictResponse({ description: "last_rbac_manager", type: ErrorResponse })
  public async remove(
    @CurrentUserId() actorUserId: string,
    @Param("grantId", ParseUUIDPipe) grantId: string,
  ) {
    await this.grantsService.remove(actorUserId, grantId);
  }
}
