import {
  Controller,
  HttpCode,
  Logger,
  Post,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import {
  ApiCookieAuth,
  ApiNoContentResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";
import { Throttle, ThrottlerGuard } from "@nestjs/throttler";
import { ConfigService } from "@nestjs/config";
import type { Request, Response } from "express";
import { SessionService } from "./services/session.service";
import { ErrorResponse } from "./dto/auth-responses.dto";
import {
  REFRESH_COOKIE,
  clearAuthCookies,
  cookieSameSite,
  setAuthCookies,
} from "./helpers/auth-cookies";

@ApiTags("Authentication")
@Controller("auth")
export class SessionController {
  private readonly logger = new Logger(SessionController.name);

  constructor(
    private readonly sessionService: SessionService,
    private readonly config: ConfigService,
  ) {}

  @Post("refresh")
  @HttpCode(204)
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiCookieAuth(REFRESH_COOKIE)
  @ApiOperation({
    summary: "Обновление пары токенов",
    description:
      "Refresh берётся только из cookie refresh_token. Для активного пользователя устанавливает новые access_token и refresh_token.",
  })
  @ApiNoContentResponse({ description: "Новая пара cookies установлена" })
  @ApiUnauthorizedResponse({
    description:
      "invalid_session: refresh отсутствует, невалиден, истёк или пользователь не активен",
    type: ErrorResponse,
  })
  @ApiTooManyRequestsResponse({
    description: "Больше 30 запросов в минуту с IP",
    type: ErrorResponse,
  })
  @ApiServiceUnavailableResponse({
    description: "База или подпись токенов недоступны, cookies не меняются",
    type: ErrorResponse,
  })
  public async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const cookies = req.cookies as Record<string, string> | undefined;
    const tokens = await this.sessionService.refresh(cookies?.[REFRESH_COOKIE]);
    setAuthCookies(res, tokens, cookieSameSite(this.config));
  }

  @Post("logout")
  @HttpCode(204)
  @ApiOperation({
    summary: "Выход",
    description:
      "Очищает access_token и refresh_token текущего клиента. Не требует валидной сессии и всегда отвечает 204.",
  })
  @ApiNoContentResponse({ description: "Cookies очищены" })
  public logout(@Res({ passthrough: true }) res: Response) {
    clearAuthCookies(res, cookieSameSite(this.config));
    this.logger.log("Logout completed");
  }
}
