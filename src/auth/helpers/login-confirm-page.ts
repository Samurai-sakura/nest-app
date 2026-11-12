// токен лежит во фрагменте URL: браузер не отправляет его на сервер при GET,
// скрипт читает его, убирает из адресной строки и отправляет POST по кнопке
export const LOGIN_CONFIRM_PAGE_HTML = `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Подтверждение входа</title>
  </head>
  <body>
    <h1>Подтверждение входа</h1>
    <p id="message">Нажмите кнопку, чтобы войти.</p>
    <button id="confirm" type="button">Войти</button>
    <script>
      const token = new URLSearchParams(location.hash.slice(1)).get("token");
      history.replaceState(null, "", location.pathname);
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
            headers: {
              "Content-Type": "application/json",
              "X-CSRF-Protection": "1",
            },
            body: JSON.stringify({ token }),
          });
          if (response.ok) {
            message.textContent = "Вход выполнен.";
            button.hidden = true;
          } else if (response.status === 400 || response.status === 401) {
            message.textContent = "Ссылка недействительна или устарела. Войдите заново.";
            button.hidden = true;
          } else {
            message.textContent = "Не удалось войти. Попробуйте ещё раз.";
            button.disabled = false;
          }
        } catch {
          message.textContent = "Не удалось войти. Попробуйте ещё раз.";
          button.disabled = false;
        }
      });
    </script>
  </body>
</html>
`;
