import { Controller, Get, HttpStatus, ServiceUnavailableException } from "@nestjs/common";
import {
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
} from "@nestjs/swagger";
import { Public } from "../authorization/decorators/public.decorator";
import { ErrorResponse } from "../auth/dto/auth-responses.dto";
import { HealthService } from "./health.service";

@ApiTags("Health")
@Public()
@Controller("health")
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get("live")
  @ApiOperation({
    summary: "Liveness",
    description: "Процесс запущен и отвечает. Зависимости не проверяются.",
  })
  @ApiOkResponse({ description: "Процесс жив", schema: { example: { status: "ok" } } })
  public live() {
    return { status: "ok" };
  }

  @Get("ready")
  @ApiOperation({
    summary: "Readiness",
    description:
      "Приложение готово принимать запросы: база доступна, снимок RBAC загружен, у всех маршрутов есть декларация, JWT-ключи заданы.",
  })
  @ApiOkResponse({ description: "Готово", schema: { example: { status: "ready" } } })
  @ApiServiceUnavailableResponse({
    description: "not_ready: хотя бы одна проверка не прошла, подробности в журнале",
    type: ErrorResponse,
  })
  public async ready() {
    if ((await this.healthService.failedChecks()).length > 0) {
      throw new ServiceUnavailableException({
        statusCode: HttpStatus.SERVICE_UNAVAILABLE,
        code: "not_ready",
        message: "Service is not ready",
      });
    }
    return { status: "ready" };
  }
}
