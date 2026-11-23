export const EMAIL_CHANGE_CONFIRM_PAGE_HTML = `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Подтверждение нового email</title>
  </head>
  <body>
    <h1>Подтверждение нового email</h1>
    <p id="message">Нажмите кнопку, чтобы подтвердить новый адрес.</p>
    <button id="confirm" type="button">Подтвердить</button>
    <script>
      const token = new URLSearchParams(location.hash.slice(1)).get("token");
      history.replaceState(null, "", location.pathname);
      const message = document.getElementById("message");
      const button = document.getElementById("confirm");

      const finish = (text) => {
        message.textContent = text;
        button.hidden = true;
      };

      if (!token) {
        finish("В ссылке нет токена. Откройте ссылку из письма.");
      }

      button.addEventListener("click", async () => {
        button.disabled = true;
        try {
          const response = await fetch(location.pathname, {
            method: "POST",
            credentials: "same-origin",
            headers: {
              "Content-Type": "application/json",
              "X-CSRF-Protection": "1",
            },
            body: JSON.stringify({ token }),
          });
          if (response.ok) {
            finish("Новый email подтверждён.");
          } else if (response.status === 401) {
            finish("Сессия истекла. Войдите в аккаунт и снова откройте ссылку из письма.");
          } else if (response.status === 403) {
            finish("Ссылка предназначена для другого аккаунта. Войдите в нужный аккаунт и откройте её снова.");
          } else if (response.status === 409) {
            finish("Адрес уже занят или email изменён администратором. Запросите смену email заново.");
          } else if (response.status === 400 || response.status === 429) {
            finish("Ссылка недействительна или устарела. Запросите смену email заново.");
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
