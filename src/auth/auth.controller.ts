import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Post,
  Res,
  UseGuards,
} from "@nestjs/common";
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiQuery,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
} from "@nestjs/swagger";
import { ThrottlerGuard } from "@nestjs/throttler";
import type { Response } from "express";
import { AuthService } from "./services/auth.service";
import { CONFIRM_PAGE_HTML } from "./helpers/confirm-page";
import { UserRegisterDto } from "./dto/user-register.dto";
import { ConfirmRegistrationDto } from "./dto/confirm-registration.dto";
import { ResendConfirmationDto } from "./dto/resend-confirmation.dto";
import {
  ConfirmationRequiredResponse,
  ConfirmedUserResponse,
  ErrorResponse,
  RegisteredUserResponse,
} from "./dto/auth-responses.dto";

@ApiTags("Register")
@Controller("auth")
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post("register")
  @UseGuards(ThrottlerGuard)
  @ApiOperation({
    summary: "Регистрация по email и паролю",
    description:
      "Если подтверждение выключено, аккаунт сразу активен (201). Если включено, создаётся pending-аккаунт и отправляется письмо с кодом или ссылкой (202). Способ выбирает сервер.",
  })
  @ApiCreatedResponse({
    description: "Подтверждение выключено: аккаунт создан и активен",
    type: RegisteredUserResponse,
  })
  @ApiAcceptedResponse({
    description: "Подтверждение включено: письмо отправлено",
    type: ConfirmationRequiredResponse,
  })
  @ApiBadRequestResponse({
    description: "Некорректный email или пароль не проходит политику",
    type: ErrorResponse,
  })
  @ApiConflictResponse({
    description: "Email уже зарегистрирован (в том числе ожидает подтверждения)",
    type: ErrorResponse,
  })
  @ApiTooManyRequestsResponse({
    description: "Слишком частая регистрация",
    type: ErrorResponse,
  })
  @ApiServiceUnavailableResponse({
    description: "Письмо не отправлено. Аккаунт pending и попытка сохранены",
    type: ErrorResponse,
  })
  public async registerUser(
    @Body() dto: UserRegisterDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.authService.register(dto);
    if ("confirmationRequired" in result) {
      res.status(202);
    }
    return result;
  }

  @Post("register/confirm")
  @HttpCode(200)
  @ApiOperation({
    summary: "Подтверждение регистрации кодом или по ссылке",
    description:
      "Для кода: attemptId из ответа регистрации и 6 цифр из письма, не больше 5 вводов. Для ссылки: token из письма, он одноразовый. Срок действия в обоих случаях 10 минут.",
  })
  @ApiOkResponse({
    description: "Email подтверждён, аккаунт активен",
    type: ConfirmedUserResponse,
  })
  @ApiBadRequestResponse({
    description:
      "Неверный или просроченный код или токен, попытка не найдена или уже использована",
    type: ErrorResponse,
  })
  @ApiTooManyRequestsResponse({
    description: "Исчерпаны попытки ввода кода",
    type: ErrorResponse,
  })
  public confirm(@Body() dto: ConfirmRegistrationDto) {
    return this.authService.confirm(dto);
  }

  @Get("register/confirm")
  @Header("Content-Type", "text/html; charset=utf-8")
  @Header("Cache-Control", "no-store")
  @Header("Referrer-Policy", "no-referrer")
  @ApiOperation({
    summary: "Страница подтверждения по ссылке из письма",
    description:
      "Открытие страницы статус не меняет. Аккаунт активирует POST /auth/register/confirm по нажатию кнопки.",
  })
  @ApiQuery({ name: "token", required: false, type: String })
  @ApiProduces("text/html")
  @ApiOkResponse({
    description: "HTML-страница с кнопкой подтверждения",
    schema: { type: "string" },
  })
  public confirmPage() {
    return CONFIRM_PAGE_HTML;
  }

  @Post("register/resend")
  @HttpCode(202)
  @UseGuards(ThrottlerGuard)
  @ApiOperation({
    summary: "Повторная отправка письма подтверждения",
    description:
      "Не чаще раза в 60 секунд. Новый код или ссылка заменяет предыдущий, заново запускает срок действия и обнуляет счётчик вводов.",
  })
  @ApiAcceptedResponse({
    description: "Письмо отправлено",
    type: ConfirmationRequiredResponse,
  })
  @ApiBadRequestResponse({
    description:
      "Некорректный email или для него нет ожидающего подтверждения",
    type: ErrorResponse,
  })
  @ApiTooManyRequestsResponse({
    description: "Прошло меньше 60 секунд с прошлой отправки или слишком частые запросы",
    type: ErrorResponse,
  })
  @ApiServiceUnavailableResponse({
    description: "Письмо не отправлено",
    type: ErrorResponse,
  })
  public resend(@Body() dto: ResendConfirmationDto) {
    return this.authService.resend(dto);
  }
}
