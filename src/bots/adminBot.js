import { Telegraf, Markup } from 'telegraf';

export async function startAdminBot({ pool }) {
  const token = process.env.ADMIN_BOT_TOKEN;
  if (!token) {
    console.warn('[adminBot] ADMIN_BOT_TOKEN missing; bot not started');
    return;
  }
  const bot = new Telegraf(token);

  const webUrl = () => {
    const base = process.env.PUBLIC_BASE_URL || '';
    return `${base}/public/index.html?role=admin`;
  };

  function isAllowedAdmin(tgId) {
    const allow = (process.env.ADMIN_TG_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!allow.length) return true;
    return allow.includes(String(tgId));
  }

  bot.start(async (ctx) => {
    if (!isAllowedAdmin(ctx.from.id)) return ctx.reply('Bu bot yalnız admin üçündür.');

    const tg = ctx.from;
    await pool.query(
      `INSERT INTO users (tg_id, role, first_name, last_name, username)
       VALUES ($1,'admin',$2,$3,$4)
       ON CONFLICT (tg_id) DO UPDATE SET role='admin', updated_at=NOW()`,
      [tg.id, tg.first_name || null, tg.last_name || null, tg.username || null]
    );

    await ctx.reply('PayTaksi Admin 🛠️', Markup.keyboard([
      [Markup.button.webApp('🛠️ Admin Panel', webUrl())],
      ['📥 TopUp-lar', '✅ Sürücüləri təsdiq et']
    ]).resize());
  });

  bot.hears('📥 TopUp-lar', async (ctx) => {
    if (!isAllowedAdmin(ctx.from.id)) return;
    const q = await pool.query(`SELECT t.*, u.first_name, u.last_name, u.tg_id FROM topups t
                                JOIN users u ON u.id=t.driver_user_id
                                WHERE t.status='pending' ORDER BY t.created_at DESC LIMIT 10`);
    if (!q.rows.length) return ctx.reply('Pending topup yoxdur.');

    for (const t of q.rows) {
      const text = `TopUp #${t.id}\nSürücü: ${t.first_name || ''} ${t.last_name || ''} (tg:${t.tg_id})\nMəbləğ: ${t.amount_azn} AZN\nMetod: ${t.method}`;
      await ctx.replyWithPhoto(t.receipt_file_id, {
        caption: text,
        ...Markup.inlineKeyboard([
          Markup.button.callback(`✅ Approve #${t.id}`, `topup:approve:${t.id}`),
          Markup.button.callback(`❌ Reject #${t.id}`, `topup:reject:${t.id}`)
        ])
      });
    }
  });

  bot.hears('✅ Sürücüləri təsdiq et', async (ctx) => {
    if (!isAllowedAdmin(ctx.from.id)) return;
    const q = await pool.query(`SELECT d.*, u.first_name, u.last_name, u.tg_id FROM drivers d
                                JOIN users u ON u.id=d.user_id
                                WHERE d.status='pending' ORDER BY d.created_at DESC LIMIT 10`);
    if (!q.rows.length) return ctx.reply('Pending sürücü yoxdur.');

    for (const d of q.rows) {
      const text = `Sürücü (pending)\n${d.first_name || ''} ${d.last_name || ''} (tg:${d.tg_id})\nAvto: ${d.car_make || ''} ${d.car_model || ''}\nNömrə: ${d.car_plate || ''}\nOperator: ${d.operator || ''}`;
      if (d.car_photo_file_id) {
        await ctx.replyWithPhoto(d.car_photo_file_id, {
          caption: text,
          ...Markup.inlineKeyboard([
            Markup.button.callback('✅ Təsdiq et', `driver:approve:${d.user_id}`),
            Markup.button.callback('❌ Rədd et', `driver:reject:${d.user_id}`)
          ])
        });
      } else {
        await ctx.reply(text, Markup.inlineKeyboard([
          Markup.button.callback('✅ Təsdiq et', `driver:approve:${d.user_id}`),
          Markup.button.callback('❌ Rədd et', `driver:reject:${d.user_id}`)
        ]));
      }
    }
  });

  bot.on('callback_query', async (ctx) => {
    if (!isAllowedAdmin(ctx.from.id)) return ctx.answerCbQuery('not allowed');
    const data = ctx.callbackQuery?.data || '';

    if (data.startsWith('topup:')) {
      const [, action, idStr] = data.split(':');
      const id = Number(idStr);
      await pool.query('BEGIN');
      try {
        const q = await pool.query(`SELECT * FROM topups WHERE id=$1 FOR UPDATE`, [id]);
        const t = q.rows[0];
        if (!t || t.status !== 'pending') { await pool.query('ROLLBACK'); return ctx.answerCbQuery('already'); }

        const newStatus = action === 'approve' ? 'approved' : 'rejected';
        await pool.query(`UPDATE topups SET status=$1, decided_at=NOW() WHERE id=$2`, [newStatus, id]);
        if (action === 'approve') {
          await pool.query(`UPDATE drivers SET balance_azn = balance_azn + $1 WHERE user_id=$2`, [t.amount_azn, t.driver_user_id]);
        }
        await pool.query('COMMIT');
        await ctx.answerCbQuery(newStatus);
      } catch (e) {
        await pool.query('ROLLBACK');
        await ctx.answerCbQuery('error');
      }
      return;
    }

    if (data.startsWith('driver:')) {
      const [, action, userIdStr] = data.split(':');
      const userId = Number(userIdStr);
      const newStatus = action === 'approve' ? 'approved' : 'rejected';
      await pool.query(`UPDATE drivers SET status=$1 WHERE user_id=$2`, [newStatus, userId]);
      await ctx.answerCbQuery(newStatus);
      return;
    }

    return ctx.answerCbQuery('ok');
  });

  bot.command('panel', (ctx) => {
    if (!isAllowedAdmin(ctx.from.id)) return;
    return ctx.reply('Admin panel:', Markup.inlineKeyboard([
      Markup.button.webApp('Aç', webUrl())
    ]));
  });

  await bot.launch();
  console.log('[adminBot] started');
}
