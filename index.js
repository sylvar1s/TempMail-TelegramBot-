const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const mysql = require('mysql2');

// Токен бота
const token = ''; // токен

// Создаем экземпляр бота
const bot = new TelegramBot(token, { polling: true });

// Подключение к MySQL
const pool = mysql.createPool({
    host: 'localhost', // хост бд
    user: 'root', // юзер бд
    password: '', // пароль от бд
    database: 'emailt', // сама бд
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
}).promise();

// Функция для инициализации базы данных
async function initializeDatabase() {
    try {
        // Создаем таблицу users, если она не существует
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id INT AUTO_INCREMENT PRIMARY KEY,
                chat_id BIGINT NOT NULL UNIQUE,
                is_vip BOOLEAN DEFAULT FALSE,
                temp_email VARCHAR(255),
                account_id VARCHAR(255),
                last_checked TIMESTAMP NULL DEFAULT NULL
            )
        `);

        console.log('✅ База данных и таблицы инициализированы.');
    } catch (error) {
        console.error('❌ Ошибка при инициализации базы данных:', error);
    }
}

// Функция для создания временной почты через mail.gw
async function createTempEmail() {
    try {
        const domainsResponse = await axios.get('https://api.mail.gw/domains');
        const domains = domainsResponse.data['hydra:member'];

        if (!domains || domains.length === 0) {
            throw new Error('Нет доступных доменов.');
        }

        const domain = domains[0].domain;
        const email = `${Math.random().toString(36).substring(2, 10)}@${domain}`;

        const registerResponse = await axios.post('https://api.mail.gw/accounts', {
            address: email,
            password: 'password'
        });

        console.log('Регистрация почты:', registerResponse.data);

        const tokenResponse = await axios.post('https://api.mail.gw/token', {
            address: email,
            password: 'password'
        });

        return {
            email,
            token: tokenResponse.data.token,
            accountId: registerResponse.data.id // Сохраняем accountId
        };
    } catch (error) {
        console.error('❌ Ошибка при создании временной почты:', error.response ? error.response.data : error.message);
        return null;
    }
}

// Функция для проверки писем через mail.gw
async function checkEmails(token) {
    try {
        const response = await axios.get('https://api.mail.gw/messages', {
            headers: {
                Authorization: `Bearer ${token}`
            }
        });
        return response.data['hydra:member'] || [];
    } catch (error) {
        console.error('❌ Ошибка при проверке писем:', error.response ? error.response.data : error.message);
        return [];
    }
}

// Обработчик команды /start
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;

    // Проверяем, есть ли пользователь в базе данных
    const [user] = await pool.query('SELECT * FROM users WHERE chat_id = ?', [chatId]);

    if (user.length === 0) {
        // Добавляем нового пользователя
        await pool.query('INSERT INTO users (chat_id, is_vip) VALUES (?, ?)', [chatId, false]);
    }

    // Отправляем приветственное сообщение с кнопками
    const options = {
        reply_markup: {
            inline_keyboard: [
                [{ text: '📨 Выдать почту', callback_data: 'create_email' }]
            ]
        }
    };

    bot.sendMessage(
        chatId,
        `👋 Привет, ${msg.from.first_name}! Я — бот для создания временной почты.\n\n`,
        options
    );
});

// Обработчик команды /vip @username
bot.onText(/\/vip (@\w+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const username = match[1].replace('@', ''); // Убираем @ из username

    // Проверяем, есть ли пользователь в базе данных
    const [user] = await pool.query('SELECT * FROM users WHERE chat_id = ?', [chatId]);

    if (user.length === 0) {
        bot.sendMessage(chatId, '❌ Пользователь не найден в базе данных.');
        return;
    }

    // Обновляем статус пользователя на VIP
    await pool.query('UPDATE users SET is_vip = TRUE WHERE chat_id = ?', [chatId]);

    bot.sendMessage(chatId, `✅ Пользователь @${username} теперь VIP!`);
});

bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;

    if (query.data === 'create_email') {
        const [user] = await pool.query('SELECT * FROM users WHERE chat_id = ?', [chatId]);
        //  випка пользователя проверка
        if (!user[0].is_vip) {
            bot.sendMessage(chatId, '❌ У вас нет VIP-статуса. Для использования этой функции необходимо быть VIP.');
            return;
        }

        // создается временная почту
        const tempEmail = await createTempEmail();

        if (tempEmail) {
            // Обновляем данные пользователя
            await pool.query(
                'UPDATE users SET temp_email = ?, last_checked = ?, account_id = ? WHERE chat_id = ?',
                [tempEmail.email, new Date(), tempEmail.accountId, chatId]
            );

            bot.sendMessage(
                chatId,
                `📨 Ваша временная почта: \n\n` +
                `🔐 ${tempEmail.email}\n\n` +
                'Я буду проверять её в течение 30 минут и присылать тебе новые письма. 📩'
            );

            // Запускаем проверку писем
            startEmailChecker(chatId, tempEmail.token);
        } else {
            bot.sendMessage(chatId, '❌ Произошла ошибка при создании временной почты. Попробуй еще раз.');
        }
    }
});

// проверка писем
function startEmailChecker(chatId, token) {
    const interval = setInterval(async () => {
        const [user] = await pool.query('SELECT * FROM users WHERE chat_id = ?', [chatId]);
        if (!user[0].temp_email) {
            clearInterval(interval);
            return;
        }
        // Проверяем, прошло ли 30 минут
        if (new Date() - user[0].last_checked > 30 * 60 * 1000) {
            clearInterval(interval);

            // Удаляем временную почту из базы данных
            await pool.query(
                'UPDATE users SET temp_email = NULL, account_id = NULL WHERE chat_id = ?',
                [chatId]
            );

            bot.sendMessage(
                chatId,
                '⌛ Почта удалена. Вы можете создать новую временную почту.'
            );

            // Показываем кнопку "Выдать почту" снова
            const options = {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '📨 Выдать почту', callback_data: 'create_email' }]
                    ]
                }
            };
            bot.sendMessage(chatId, 'Выберите действие:', options);
            return;
        }

        // Проверяем новые письма
        const emails = await checkEmails(token);
        console.log('Найдены письма:', emails);

        if (emails && emails.length > 0) {
            for (const email of emails) {
                const [sentEmail] = await pool.query(
                    'SELECT * FROM sent_emails WHERE chat_id = ? AND email_id = ?',
                    [chatId, email.id]
                );

                if (sentEmail.length === 0) {
                    console.log('Новое письмо:', email.id);
                    const messageResponse = await axios.get(`https://api.mail.gw/messages/${email.id}`, {
                        headers: {
                            Authorization: `Bearer ${token}`
                        }
                    });
                    const message = messageResponse.data;
                    console.log('Данные письма:', message);

                    // Отправляем письмо пользователю
                    bot.sendMessage(
                        chatId,
                        `📩 **Новое письмо!**\n\n` +
                        `👤 От: ${message.from.name} <${message.from.address}>\n` +
                        `📌 Тема: ${message.subject}\n` +
                        `📝 Текст: \n\n${message.text || message.html}`
                    );

                    // Сохраняем письмо как отправленное
                    await pool.query(
                        'INSERT INTO sent_emails (chat_id, email_id, from_email, to_email, message_text) VALUES (?, ?, ?, ?, ?)',
                        [chatId, email.id, message.from.address, user[0].temp_email, message.text || message.html]
                    );
                }
            }
        }

        // Обновляем время последней проверки
        await pool.query(
            'UPDATE users SET last_checked = ? WHERE chat_id = ?',
            [new Date(), chatId]
        );
    }, 60000); // Проверяем каждую минуту
}

// Инициализация базы данных и запуск бота
initializeDatabase().then(() => {
    console.log('Бот запущен.');
});