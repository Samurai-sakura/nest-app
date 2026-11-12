import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Ip,
  Post,
  Res,
  UseGuards,
} from "@nestjs/common";
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";
import { Throttle, ThrottlerGuard } from "@nestjs/throttler";
import { ConfigService } from "@nestjs/config";
import type { Response } from "express";
import { LoginService } from "./services/login.service";
import { LoginChallengeService } from "./services/login-challenge.service";
import { UserLoginDto } from "./dto/user-login.dto";
import { ConfirmLoginDto } from "./dto/confirm-login.dto";
import { ResendLoginDto } from "./dto/resend-login.dto";
import {
  ConfirmationRequiredResponse,
  ErrorResponse,
  LoginResendResponse,
} from "./dto/auth-responses.dto";
import { cookieSameSite, setAuthCookies } from "./helpers/auth-cookies";
import { LOGIN_CONFIRM_PAGE_HTML } from "./helpers/login-confirm-page";

@ApiTags("Authentication")
@Controller("auth")
export class LoginController {
  constructor(
    private readonly loginService: LoginService,
    private readonly challengeService: LoginChallengeService,
    private readonly config: ConfigService,
  ) {}

  @Post("login")
  @HttpCode(204)
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({
    summary: "Вход по email и паролю",
    description:
      "Без подтверждения устанавливает HttpOnly cookies access_token и refresh_token (204). С подтверждением отправляет код или ссылку на email (202). Способ выбирает сервер.",
  })
  @ApiNoContentResponse({ description: "Вход выполнен, cookies установлены" })
  @ApiAcceptedResponse({
    description: "Нужно подтверждение по email",
    type: ConfirmationRequiredResponse,
  })
  @ApiBadRequestResponse({ description: "Некорректный формат", type: ErrorResponse })
  @ApiUnauthorizedResponse({
    description:
      "invalid_credentials: неизвестный email, неверный пароль или аккаунт не активен",
    type: ErrorResponse,
  })
  @ApiTooManyRequestsResponse({
    description:
      "Больше 30 запросов в минуту с IP, 5 неудачных входов за 15 минут или письмо запрошено раньше 60 секунд",
    type: ErrorResponse,
  })
  @ApiServiceUnavailableResponse({
    description:
      "База, подпись токенов или почта недоступны. Если не ушло письмо, тело содержит attemptId",
    type: ErrorResponse,
  })
  public async login(
    @Body() dto: UserLoginDto,
    @Ip() ip: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.loginService.login(dto, ip);
    if ("challenge" in result) {
      res.status(202);
      return result.challenge;
    }
    setAuthCookies(res, result.tokens, cookieSameSite(this.config));
  }

  @Post("login/confirm")
  @HttpCode(204)
  @ApiOperation({
    summary: "Подтверждение входа кодом или по ссылке",
    description:
      "Для кода: attemptId и 6 цифр из письма, не больше 5 вводов. Для ссылки: token из письма в формате attemptId.secret. Срок действия 10 минут.",
  })
  @ApiNoContentResponse({ description: "Вход выполнен, cookies установлены" })
  @ApiBadRequestResponse({
    description:
      "Неверный или просроченный код или токен, попытка не найдена, заменена или уже использована",
    type: ErrorResponse,
  })
  @ApiUnauthorizedResponse({
    description: "invalid_credentials: аккаунт больше не активен",
    type: ErrorResponse,
  })
  @ApiTooManyRequestsResponse({
    description: "Исчерпаны попытки ввода кода",
    type: ErrorResponse,
  })
  @ApiServiceUnavailableResponse({
    description: "База или подпись токенов недоступны, попытку можно подтвердить снова",
    type: ErrorResponse,
  })
  public async confirm(
    @Body() dto: ConfirmLoginDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const tokens = await this.challengeService.confirm(dto);
    setAuthCookies(res, tokens, cookieSameSite(this.config));
  }

  @Get("login/confirm")
  @Header("Content-Type", "text/html; charset=utf-8")
  @Header("Cache-Control", "no-store")
  @Header("Referrer-Policy", "no-referrer")
  @ApiOperation({
    summary: "Страница подтверждения входа по ссылке из письма",
    description:
      "Токен передаётся во фрагменте URL и на сервер не уходит. Вход выполняет POST /auth/login/confirm по нажатию кнопки.",
  })
  @ApiProduces("text/html")
  @ApiOkResponse({
    description: "HTML-страница с кнопкой входа",
    schema: { type: "string" },
  })
  public confirmPage() {
    return LOGIN_CONFIRM_PAGE_HTML;
  }

  @Post("login/resend")
  @HttpCode(202)
  @ApiOperation({
    summary: "Повторная отправка письма для входа",
    description:
      "Не чаще раза в 60 секунд. Новый код или ссылка заменяет прежний, заново запускает срок действия и обнуляет счётчик вводов.",
  })
  @ApiAcceptedResponse({ description: "Письмо отправлено", type: LoginResendResponse })
  @ApiBadRequestResponse({
    description: "Попытка не найдена, заменена или уже использована",
    type: ErrorResponse,
  })
  @ApiUnauthorizedResponse({
    description: "invalid_credentials: аккаунт больше не активен",
    type: ErrorResponse,
  })
  @ApiTooManyRequestsResponse({
    description: "Прошло меньше 60 секунд или исчерпаны попытки ввода кода",
    type: ErrorResponse,
  })
  @ApiServiceUnavailableResponse({ description: "Письмо не отправлено", type: ErrorResponse })
  public resend(@Body() dto: ResendLoginDto) {
    return this.challengeService.resend(dto.attemptId);
  }
}
