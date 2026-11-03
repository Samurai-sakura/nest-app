export const CONFIRM_PAGE_HTML = `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Подтверждение регистрации</title>
  </head>
  <body>
    <h1>Подтверждение регистрации</h1>
    <p id="message">Нажмите кнопку, чтобы подтвердить email.</p>
    <button id="confirm" type="button">Подтвердить</button>
    <script>
      const token = new URLSearchParams(location.search).get("token");
      const message = document.getElementById("message");
      const button = document.getElementById("confirm");

      if (!token) {
        message.textContent = "В ссылке нет токена. Откройте ссылку из письма.";
        button.hidden = true;
      }

      button.addEventListener("click", async () => {
        button.disabled = true;
        try {
          const response = await fetch(location.pathname, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token }),
          });
          if (response.ok) {
            message.textContent = "Email подтверждён, аккаунт активен.";
            button.hidden = true;
          } else if (response.status === 400) {
            message.textContent = "Ссылка недействительна или устарела. Запросите новое письмо.";
            button.hidden = true;
          } else {
            message.textContent = "Не удалось подтвердить email. Попробуйте ещё раз.";
            button.disabled = false;
          }
        } catch {
          message.textContent = "Не удалось подтвердить email. Попробуйте ещё раз.";
          button.disabled = false;
        }
      });
    </script>
  </body>
</html>
`;
