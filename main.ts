/* ----------  Импортируем SDK и полезные enum-ы ---------- */
import StreamingAvatar, {               // основной класс SDK для работы с аватаром
  AvatarQuality,                        // enum качества видеопотока (Low, Medium, High)
  StreamingEvents,                      // enum всех Web-событий SDK (подключение, сообщения и т.д.)
  VoiceChatTransport                    // enum транспортов для голосового чата (WebSocket/WebRTC)
} from "@heygen/streaming-avatar";

/* ----------  Проверка поддержки браузера ---------- */
// Проверяем, поддерживает ли браузер необходимые API для работы с медиа
if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
  alert('Ваш браузер не поддерживает работу с медиа-устройствами. Пожалуйста, используйте современный браузер.');
  throw new Error('Browser does not support media devices');
}

/* ----------  Переменные из .env (доступны через Vite) ---------- */
const ACCESS_KEY      = import.meta.env.VITE_APP_ACCESS_KEY!;    // ключ авторизации пользователя для доступа к приложению
const HEYGEN_API_KEY  = import.meta.env.VITE_HEYGEN_API_KEY!;    // API-ключ HeyGen для аутентификации в сервисе
const KB_ID           = import.meta.env.VITE_HEYGEN_KB_ID!;      // ID вашей базы знаний в HeyGen

/* ----------  Проверка наличия необходимых переменных окружения ---------- */
if (!ACCESS_KEY || !HEYGEN_API_KEY || !KB_ID) {
  console.error('Отсутствуют необходимые переменные окружения');
  alert('Ошибка конфигурации приложения. Проверьте файл .env');
  throw new Error('Missing environment variables');
}

/* ----------  DOM-элементы интерфейса ---------- */
// Получаем ссылки на элементы DOM с проверкой их существования
const loginForm  = document.getElementById("loginForm")  as HTMLFormElement | null;   // форма ввода ключа доступа
const keyInput   = document.getElementById("accessKeyInput") as HTMLInputElement | null; // поле ввода ключа
const errLabel   = document.getElementById("loginError") as HTMLElement | null;       // метка для отображения ошибки входа
const video      = document.getElementById("video")      as HTMLVideoElement | null;  // <video> элемент для отображения стрима аватара
const modeBtn    = document.getElementById("modeBtn")    as HTMLButtonElement | null; // кнопка переключения режима «Avatar/Chat»
const endBtn     = document.getElementById("endBtn")     as HTMLButtonElement | null; // кнопка завершения сессии
const loadingDiv = document.getElementById("loading")    as HTMLElement | null;       // индикатор загрузки (добавьте в HTML)

/* ----------  Проверка наличия всех необходимых DOM элементов ---------- */
if (!loginForm || !keyInput || !errLabel || !video || !modeBtn || !endBtn) {
  console.error('Не найдены необходимые DOM элементы');
  alert('Ошибка инициализации интерфейса. Проверьте HTML разметку.');
  throw new Error('Required DOM elements not found');
}

/* ----------  Переменные состояния сессии ---------- */
let avatar: StreamingAvatar | null = null;    // текущий экземпляр аватара (null когда сессия не активна)
let mode:   "avatar" | "chat" = "avatar";     // активный режим: avatar (голосовой чат) или chat (текстовый)
let transcript: string[] = [];                // массив строк истории диалога для экспорта
let startAt   = 0;                            // timestamp начала сессии в миллисекундах
let lastPing  = 0;                            // timestamp последней активности пользователя/аватара
let limitMs   = 0;                            // абсолютный лимит длительности сессии от сервера
let watchDogInterval: number | null = null;   // ID интервала для watchdog таймера
const idleMs  = 5 * 60_000;                   // 5-минутный таймаут простоя (300000 мс)

/* ----------  Функция отображения/скрытия индикатора загрузки ---------- */
function showLoading(show: boolean) {
  // Если элемент загрузки существует, управляем его видимостью
  if (loadingDiv) {
    loadingDiv.style.display = show ? 'block' : 'none';
  }
}

/* ----------  Функция отображения ошибок пользователю ---------- */
function showError(message: string) {
  // Выводим ошибку в консоль для отладки
  console.error(message);
  // Показываем пользователю понятное сообщение
  alert(message);
  // Скрываем индикатор загрузки
  showLoading(false);
}

/* ----------  Проверяем ключ доступа пользователя ---------- */
loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();                                           // блокируем стандартную отправку формы

  // Проверяем введенный ключ с сохраненным в переменных окружения
  if (keyInput.value === ACCESS_KEY) {
    try {
      loginForm.style.display = "none";                        // скрываем форму входа
      video.style.display     = "block";                       // показываем <video> элемент
      showLoading(true);                                       // показываем индикатор загрузки
      await initSession();                                     // инициализируем сессию с аватаром
    } catch (error) {
      // В случае ошибки возвращаем форму входа
      loginForm.style.display = "block";
      video.style.display     = "none";
      showError('Не удалось инициализировать сессию. Попробуйте позже.');
    }
  } else {
    errLabel.style.display  = "block";                         // показываем сообщение об ошибке
    // Автоматически скрываем ошибку через 3 секунды
    setTimeout(() => {
      errLabel.style.display = "none";
    }, 3000);
  }
});

/* ----------  Запрашиваем временный токен на сессию ---------- */
async function getToken(): Promise<string> {
  try {
    // Отправляем POST запрос на эндпоинт HeyGen для получения токена
    const response = await fetch("https://api.heygen.com/v1/streaming.create_token", {
      method: "POST",
      headers: {
        "x-api-key": HEYGEN_API_KEY,                          // передаем API ключ в заголовке
        "Content-Type": "application/json"                     // указываем тип контента
      }
    });

    // Проверяем успешность ответа
    if (!response.ok) {
      throw new Error(`Ошибка получения токена: ${response.status} ${response.statusText}`);
    }

    // Парсим JSON ответ
    const data = await response.json();

    // Проверяем наличие токена в ответе
    if (!data.data || !data.data.token) {
      throw new Error('Токен не найден в ответе сервера');
    }

    return data.data.token as string;                         // возвращаем полученный токен
  } catch (error) {
    console.error('Ошибка при получении токена:', error);
    throw error;                                               // пробрасываем ошибку выше
  }
}

/* ----------  Инициализируем видеопоток и голосовой чат ---------- */
async function initSession() {
  try {
    const token = await getToken();                            // получаем токен для сессии
    avatar = new StreamingAvatar({ token });                   // создаём экземпляр SDK с токеном

    /* --- Подписываемся на события потока --- */
    // Событие готовности WebRTC соединения
    avatar.on(StreamingEvents.STREAM_READY, (ev) => {
      console.log('Поток готов к отображению');
      video.srcObject = ev.detail;                             // прикрепляем MediaStream к video элементу
      // Ждем загрузки метаданных и начинаем воспроизведение
      video.onloadedmetadata = () => {
        video.play()
          .then(() => {
            console.log('Видео успешно запущено');
            showLoading(false);                                // скрываем индикатор загрузки
          })
          .catch(err => {
            console.error('Ошибка воспроизведения видео:', err);
            showError('Не удалось запустить видео. Проверьте разрешения браузера.');
          });
      };
    });

    // Событие разрыва соединения
    avatar.on(StreamingEvents.STREAM_DISCONNECTED, () => {
      console.log('Соединение разорвано');
      stopSession();                                           // завершаем сессию при обрыве
    });

    /* --- Подписываемся на события сообщений --- */
    // Событие завершения сообщения от пользователя
    avatar.on(StreamingEvents.USER_END_MESSAGE, (message) => {
      console.log('Пользователь сказал:', message.text);
      log("User", message.text);                               // записываем в историю
    });

    // Событие завершения сообщения от аватара
    avatar.on(StreamingEvents.AVATAR_END_MESSAGE, (message) => {
      console.log('Аватар ответил:', message.text);
      log("Avatar", message.text);                             // записываем в историю
    });

    /* --- События активности для keep-alive --- */
    // Пользователь начал говорить
    avatar.on(StreamingEvents.USER_START, () => {
      console.log('Пользователь начал говорить');
      heartbeat();                                             // обновляем таймер активности
    });

    // Аватар начал говорить
    avatar.on(StreamingEvents.AVATAR_START_TALKING, () => {
      console.log('Аватар начал говорить');
      heartbeat();                                             // обновляем таймер активности
    });

    /* --- Создаём сессию с аватаром --- */
    console.log('Создаем сессию с аватаром...');
    const sessionResponse = await avatar.createStartAvatar({
      avatarName: "Wayne_20240711",                            // ID предустановленного аватара
      quality: AvatarQuality.High,                             // высокое качество видео (HD)
      knowledgeBaseId: KB_ID,                                  // подключаем базу знаний для ответов
      voiceChatTransport: VoiceChatTransport.WEBSOCKET,       // используем WebSocket для голосового чата
      activityIdleTimeout: 300,                                // таймаут неактивности на сервере (300 сек)
      disableIdleTimeout: false                                // не отключаем idle-таймаут (будем использовать keepAlive)
    });

    // Проверяем успешность создания сессии
    if (!sessionResponse.data) {
      throw new Error('Не удалось создать сессию с аватаром');
    }

    /* --- Сохраняем параметры времени сессии --- */
    limitMs = sessionResponse.data.session_duration_limit * 1000; // конвертируем лимит из секунд в миллисекунды
    startAt = lastPing = Date.now();                             // запоминаем время старта и последней активности

    /* --- Запускаем голосовой чат --- */
    console.log('Запускаем голосовой чат...');
    await avatar.startVoiceChat({
      useSilencePrompt: true                                   // используем детекцию тишины для завершения фразы
    });

    /* --- Активируем элементы управления --- */
    modeBtn.disabled = endBtn.disabled = false;                // делаем кнопки активными
    modeBtn.textContent = "Mode: Avatar";                      // устанавливаем начальный текст кнопки
    modeBtn.onclick = toggleMode;                              // назначаем обработчик переключения режима
    endBtn.onclick = stopSession;                               // назначаем обработчик завершения сессии

    // Запускаем мониторинг таймаутов
    watchDog();

    console.log('Сессия успешно инициализирована');
    showLoading(false);                                        // скрываем индикатор загрузки

  } catch (error) {
    console.error('Ошибка инициализации сессии:', error);
    showError('Не удалось запустить сессию. Проверьте подключение и попробуйте снова.');
    // Очищаем ресурсы при ошибке
    if (avatar) {
      avatar.stopAvatar().catch(console.error);
      avatar = null;
    }
    throw error;
  }
}

/* ----------  Функция записи текста в историю диалога ---------- */
function log(who: string, txt: string) {
  // Добавляем временную метку к сообщению
  const timestamp = new Date().toLocaleTimeString();
  const entry = `[${timestamp}] [${who}] ${txt}`;
  transcript.push(entry);                                      // добавляем в массив истории
  console.log('История:', entry);
  heartbeat();                                                 // обновляем таймер активности
}

/* ----------  Keep-alive: сбрасываем idle-таймер на сервере ---------- */
function heartbeat() {
  lastPing = Date.now();                                       // обновляем локальную метку времени
  // Отправляем keep-alive запрос на сервер если аватар активен
  if (avatar) {
    avatar.keepAlive()
      .then(() => console.log('Keep-alive отправлен'))
      .catch(err => console.error('Ошибка keep-alive:', err));
  }
}

/* ----------  Переключаем режим Avatar ↔ Chat ---------- */
async function toggleMode() {
  if (!avatar) return;                                         // защита от вызова без активной сессии

  try {
    showLoading(true);                                         // показываем индикатор загрузки

    if (mode === "avatar") {                                   // переключение из режима Avatar в Chat
      console.log('Переключение в режим Chat...');
      await avatar.closeVoiceChat();                           // закрываем голосовой канал
      mode = "chat";                                           // обновляем текущий режим
      modeBtn.textContent = "Mode: Chat";                      // обновляем текст кнопки
    } else {                                                   // переключение из режима Chat в Avatar
      console.log('Переключение в режим Avatar...');
      await avatar.startVoiceChat({
        useSilencePrompt: true                                 // включаем детекцию тишины
      });
      mode = "avatar";
      modeBtn.textContent = "Mode: Avatar";
    }

    heartbeat();                                               // обновляем таймер активности
    showLoading(false);                                        // скрываем индикатор
    console.log(`Режим успешно переключен на: ${mode}`);

  } catch (error) {
    console.error('Ошибка переключения режима:', error);
    showError('Не удалось переключить режим. Попробуйте снова.');
  }
}

/* ----------  «Собака-сторож»: проверка лимитов времени и активности ---------- */
function watchDog() {
  // Запускаем интервал проверки каждую секунду
  watchDogInterval = window.setInterval(() => {
    const now = Date.now();
    const sessionDuration = now - startAt;                     // общая длительность сессии
    const idleDuration = now - lastPing;                      // время с последней активности

    // Проверяем превышение общего лимита сессии
    if (limitMs > 0 && sessionDuration >= limitMs) {
      console.log('Достигнут лимит времени сессии');
      stopSession();
    }
    // Проверяем превышение таймаута неактивности
    else if (idleDuration >= idleMs) {
      console.log('Превышен таймаут неактивности');
      stopSession();
    }

    // Логируем состояние каждые 30 секунд для отладки
    if (sessionDuration % 30000 < 1000) {
      console.log(`Сессия активна: ${Math.floor(sessionDuration / 1000)}с, ` +
                  `простой: ${Math.floor(idleDuration / 1000)}с`);
    }
  }, 1000);                                                    // проверяем каждую секунду
}

/* ----------  Завершение сессии и экспорт истории ---------- */
async function stopSession() {
  console.log('Завершение сессии...');

  // Деактивируем кнопки управления
  modeBtn.disabled = endBtn.disabled = true;

  // Останавливаем watchdog таймер
  if (watchDogInterval !== null) {
    clearInterval(watchDogInterval);
    watchDogInterval = null;
  }

  // Останавливаем аватара если он существует
  if (avatar) {
    try {
      await avatar.stopAvatar();                               // корректно завершаем сессию
      console.log('Аватар успешно остановлен');
    } catch (error) {
      console.error('Ошибка при остановке аватара:', error);
    }
    avatar = null;                                             // очищаем ссылку на аватар
  }

  // Если есть история диалога, экспортируем её
  if (transcript.length > 0) {
    exportTranscript();
  }

  // Возвращаем интерфейс в начальное состояние
  video.style.display = "none";
  loginForm.style.display = "block";
  keyInput.value = "";                                         // очищаем поле ввода

  console.log('Сессия завершена');
}

/* ----------  Функция экспорта истории диалога ---------- */
function exportTranscript() {
  try {
    // Добавляем заголовок с информацией о сессии
    const sessionInfo = [
      "=== ИСТОРИЯ ДИАЛОГА С АВАТАРОМ ===",
      `Дата: ${new Date().toLocaleString()}`,
      `Длительность: ${Math.floor((Date.now() - startAt) / 1000)} секунд`,
      `Количество сообщений: ${transcript.length}`,
      "================================\n"
    ].join('\n');

    // Объединяем всю историю с двойными переносами между сообщениями
    const fullTranscript = sessionInfo + transcript.join('\n\n');

    // Создаём Blob объект с текстовым содержимым
    const blob = new Blob([fullTranscript], {
      type: "text/plain;charset=utf-8"                         // указываем тип и кодировку
    });

    // Создаём временный элемент <a> для скачивания
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);                     // создаём URL для blob

    // Формируем имя файла с датой и временем
    const dateStr = new Date().toISOString().slice(0, 19).replace(/[:-]/g, '');
    link.download = `avatar_session_${dateStr}.txt`;

    // Программно кликаем по ссылке для начала скачивания
    link.click();

    // Освобождаем память, удаляя временный URL
    setTimeout(() => URL.revokeObjectURL(link.href), 100);

    console.log('История диалога экспортирована');

  } catch (error) {
    console.error('Ошибка экспорта истории:', error);
    showError('Не удалось сохранить историю диалога');
  }
}

/* ----------  Обработка ошибок на уровне страницы ---------- */
window.addEventListener('error', (event) => {
  console.error('Глобальная ошибка:', event.error);
  // Не показываем все ошибки пользователю, только логируем
});

/* ----------  Обработка необработанных промисов ---------- */
window.addEventListener('unhandledrejection', (event) => {
  console.error('Необработанный промис:', event.reason);
  // Предотвращаем появление ошибки в консоли по умолчанию
  event.preventDefault();
});

/* ----------  Очистка ресурсов при закрытии страницы ---------- */
window.addEventListener('beforeunload', () => {
  // Пытаемся корректно завершить сессию перед закрытием
  if (avatar) {
    avatar.stopAvatar().catch(() => {});                      // игнорируем ошибки при закрытии
  }
});

/* ----------  Информация о готовности приложения ---------- */
console.log('HeyGen Streaming Avatar клиент инициализирован');
console.log('Версия SDK:', StreamingAvatar.VERSION || 'неизвестно');
console.log('Режим работы:', import.meta.env.MODE);
