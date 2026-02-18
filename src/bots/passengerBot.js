import { Telegraf, Markup } from 'telegraf';

export async function startPassengerBot({ pool }) {
  const token = process.env.PASSENGER_BOT_TOKEN;
  if (!token) {
    console.warn('[passengerBot] PASSENGER_BOT_TOKEN missing; bot not started');
    return;
  }
  const bot = new Telegraf(token);

  const webUrl = () => {
    const base = process.env.PUBLIC_BASE_URL || '';
    return `${base}/public/index.html?role=passenger`;
  };

  bot.start(async (ctx) => {
    const tg = ctx.from;
    await pool.query(
      `INSERT INTO users (tg_id, role, first_name, last_name, username)
       VALUES ($1,'passenger',$2,$3,$4)
       ON CONFLICT (tg_id) DO UPDATE SET role='passenger', updated_at=NOW()`,
      [tg.id, tg.first_name || null, tg.last_name || null, tg.username || null]
    );
    const u = await pool.query(`SELECT id FROM users WHERE tg_id=$1`, [tg.id]);
    await pool.query(`INSERT INTO passengers(user_id) VALUES ($1) ON CONFLICT DO NOTHING`, [u.rows[0].id]);

    await ctx.reply(
      'PayTaksi 🚕\n\nSərnişin paneli açmaq üçün düyməni basın.\nQeydiyyat üçün telefon nömrənizi göndərmək məsləhətdir.',
      Markup.keyboard([
        Markup.button.contactRequest('📞 Telefonu göndər'),
        Markup.button.webApp('🚕 PayTaksi-də sifariş ver', webUrl())
      ]).resize()
    );
  });

  bot.on('contact', async (ctx) => {
    const phone = ctx.message?.contact?.phone_number;
    if (!phone) return;
    await pool.query(`UPDATE users SET phone=$1, updated_at=NOW() WHERE tg_id=$2`, [phone, ctx.from.id]);
    await ctx.reply('✅ Telefon nömrəniz yadda saxlanıldı.');
  });

  bot.command('panel', (ctx) => ctx.reply('Sərnişin paneli:', Markup.inlineKeyboard([
    Markup.button.webApp('Aç', webUrl())
  ])));

  await bot.launch();
  console.log('[passengerBot] started');
}
