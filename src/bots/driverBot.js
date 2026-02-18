import { Telegraf, Markup } from 'telegraf';

const sessions = new Map(); // tg_id -> { step, data }

export async function startDriverBot({ pool }) {
  const token = process.env.DRIVER_BOT_TOKEN;
  if (!token) {
    console.warn('[driverBot] DRIVER_BOT_TOKEN missing; bot not started');
    return;
  }
  const bot = new Telegraf(token);

  const webUrl = () => {
    const base = process.env.PUBLIC_BASE_URL || '';
    return `${base}/public/index.html?role=driver`;
  };

  async function ensureUser(ctx) {
    const tg = ctx.from;
    await pool.query(
      `INSERT INTO users (tg_id, role, first_name, last_name, username)
       VALUES ($1,'driver',$2,$3,$4)
       ON CONFLICT (tg_id) DO UPDATE SET role='driver', updated_at=NOW()`,
      [tg.id, tg.first_name || null, tg.last_name || null, tg.username || null]
    );
    const u = await pool.query(`SELECT * FROM users WHERE tg_id=$1`, [tg.id]);
    return u.rows[0];
  }

  async function getDriverByTgId(tgId) {
    const u = await pool.query(`SELECT id FROM users WHERE tg_id=$1`, [tgId]);
    const userId = u.rows[0]?.id;
    if (!userId) return null;
    const d = await pool.query(`SELECT * FROM drivers WHERE user_id=$1`, [userId]);
    return d.rows[0] || null;
  }

  bot.start(async (ctx) => {
    const user = await ensureUser(ctx);
    const driver = await pool.query(`SELECT * FROM drivers WHERE user_id=$1`, [user.id]);
    if (!driver.rows[0]) {
      sessions.set(ctx.from.id, { step: 'name', data: {} });
      await ctx.reply('PayTaksi Sürücü 🚖\n\nİlk dəfə daxil oldunuz. Qeydiyyata başlayaq.\n\nAdınızı yazın:');
      return;
    }

    await ctx.reply('PayTaksi Sürücü paneli:', Markup.keyboard([
      [Markup.button.webApp('🚖 Sürücü Paneli', webUrl())],
      ['💰 Balans', '➕ Balans artır'],
      ['📝 Qeydiyyatı yenilə']
    ]).resize());
  });

  bot.hears('💰 Balans', async (ctx) => {
    const driver = await getDriverByTgId(ctx.from.id);
    if (!driver) return ctx.reply('Qeydiyyat tapılmadı. /start');
    const blockAt = Number(process.env.DRIVER_BLOCK_BALANCE_AZN ?? -15);
    const msg = `Balans: ${driver.balance_azn} AZN\nStatus: ${driver.status}\n\nQaydа: Balans ${blockAt} AZN və ya aşağı olarsa sifariş qəbul edilmir.`;
    return ctx.reply(msg);
  });

  bot.hears('📝 Qeydiyyatı yenilə', async (ctx) => {
    sessions.set(ctx.from.id, { step: 'name', data: {} });
    return ctx.reply('Yenidən qeydiyyat: Adınızı yazın:');
  });

  bot.hears('➕ Balans artır', async (ctx) => {
    const driver = await getDriverByTgId(ctx.from.id);
    if (!driver) return ctx.reply('Qeydiyyat tapılmadı. /start');
    sessions.set(ctx.from.id, { step: 'topup_amount', data: {} });
    return ctx.reply('Məbləği yazın (AZN). Məs: 20');
  });

  bot.on('text', async (ctx) => {
    const s = sessions.get(ctx.from.id);
    if (!s) return;

    const text = (ctx.message.text || '').trim();

    if (s.step === 'name') {
      s.data.first_name_manual = text;
      s.step = 'surname';
      return ctx.reply('Soyadınızı yazın:');
    }
    if (s.step === 'surname') {
      s.data.last_name_manual = text;
      s.step = 'phone';
      return ctx.reply('Telefon nömrənizi göndərin (+994...):', Markup.keyboard([
        Markup.button.contactRequest('📞 Telefonu göndər')
      ]).resize());
    }

    if (s.step === 'operator') {
      s.data.operator = text;
      s.step = 'car_make';
      return ctx.reply('Avtomobil markası (məs: Toyota):');
    }
    if (s.step === 'car_make') {
      s.data.car_make = text;
      s.step = 'car_model';
      return ctx.reply('Avtomobil modeli (məs: Aqua 2017):');
    }
    if (s.step === 'car_model') {
      s.data.car_model = text;
      s.step = 'car_plate';
      return ctx.reply('Dövlət nömrəsi (məs: 90XY581):');
    }
    if (s.step === 'car_plate') {
      s.data.car_plate = text;
      s.step = 'car_photo';
      return ctx.reply('Avtomobilin şəklini göndərin (foto):');
    }

    if (s.step === 'topup_amount') {
      const amount = Number(String(text).replace(',', '.'));
      if (!Number.isFinite(amount) || amount <= 0) return ctx.reply('Məbləği düzgün yazın. Məs: 20');
      s.data.amount = amount;
      s.step = 'topup_method';
      return ctx.reply('Metod seçin:', Markup.keyboard([
        ['card_to_card', 'terminal', 'm10'],
        ['Ləğv']
      ]).resize());
    }

    if (s.step === 'topup_method') {
      if (text.toLowerCase() === 'ləğv') { sessions.delete(ctx.from.id); return ctx.reply('Ləğv edildi.'); }
      if (!['card_to_card', 'terminal', 'm10'].includes(text)) return ctx.reply('Metodu seçin: card_to_card / terminal / m10');
      s.data.method = text;
      s.step = 'topup_receipt';
      return ctx.reply('İndi ödəniş qəbzinin şəklini göndərin (foto):');
    }
  });

  bot.on('contact', async (ctx) => {
    const s = sessions.get(ctx.from.id);
    if (!s || s.step !== 'phone') return;
    const phone = ctx.message?.contact?.phone_number;
    if (!phone) return;
    s.data.phone = phone;
    s.step = 'operator';
    await ctx.reply('Operator yazın (məs: Azercell/Bakcell/Nar):', Markup.removeKeyboard());
  });

  bot.on('photo', async (ctx) => {
    const s = sessions.get(ctx.from.id);
    if (!s) return;

    const photos = ctx.message.photo;
    const best = photos?.[photos.length - 1];
    const fileId = best?.file_id;
    if (!fileId) return;

    // Registration documents flow
    if (s.step === 'car_photo') {
      s.data.car_photo_file_id = fileId;
      s.step = 'doc_id_front';
      return ctx.reply('Şəxsiyyət vəsiqəsi (üz) şəklini göndərin:');
    }
    if (s.step === 'doc_id_front') {
      s.data.doc_id_front = fileId;
      s.step = 'doc_id_back';
      return ctx.reply('Şəxsiyyət vəsiqəsi (arxa) şəklini göndərin:');
    }
    if (s.step === 'doc_id_back') {
      s.data.doc_id_back = fileId;
      s.step = 'doc_license';
      return ctx.reply('Sürücülük vəsiqəsi şəklini göndərin:');
    }
    if (s.step === 'doc_license') {
      s.data.doc_license = fileId;
      s.step = 'doc_tech_front';
      return ctx.reply('Texniki pasport (üz) şəkli:');
    }
    if (s.step === 'doc_tech_front') {
      s.data.doc_tech_front = fileId;
      s.step = 'doc_tech_back';
      return ctx.reply('Texniki pasport (arxa) şəkli:');
    }
    if (s.step === 'doc_tech_back') {
      s.data.doc_tech_back = fileId;
      // Save registration
      const user = await ensureUser(ctx);
      await pool.query(`UPDATE users SET first_name=$1, last_name=$2, phone=$3, updated_at=NOW() WHERE id=$4`, [
        s.data.first_name_manual || user.first_name,
        s.data.last_name_manual || user.last_name,
        s.data.phone || user.phone,
        user.id
      ]);

      await pool.query(
        `INSERT INTO drivers (user_id, operator, car_make, car_model, car_plate, car_photo_file_id, status)
         VALUES ($1,$2,$3,$4,$5,$6,'pending')
         ON CONFLICT (user_id) DO UPDATE SET
           operator=EXCLUDED.operator,
           car_make=EXCLUDED.car_make,
           car_model=EXCLUDED.car_model,
           car_plate=EXCLUDED.car_plate,
           car_photo_file_id=EXCLUDED.car_photo_file_id,
           status='pending'`,
        [user.id, s.data.operator, s.data.car_make, s.data.car_model, s.data.car_plate, s.data.car_photo_file_id]
      );

      const docs = [
        ['id_front', s.data.doc_id_front],
        ['id_back', s.data.doc_id_back],
        ['driver_license', s.data.doc_license],
        ['tech_front', s.data.doc_tech_front],
        ['tech_back', s.data.doc_tech_back]
      ];
      for (const [type, fid] of docs) {
        await pool.query(`INSERT INTO driver_docs(driver_user_id, doc_type, telegram_file_id)
                          VALUES ($1,$2,$3)`, [user.id, type, fid]);
      }

      sessions.delete(ctx.from.id);
      await ctx.reply('✅ Qeydiyyat tamamlandı!\nAdmin təsdiqindən sonra sifariş qəbul edə biləcəksiniz.\n\nSürücü paneli:',
        Markup.keyboard([
          [Markup.button.webApp('🚖 Sürücü Paneli', webUrl())],
          ['💰 Balans', '➕ Balans artır']
        ]).resize()
      );
      return;
    }

    // Topup receipt
    if (s.step === 'topup_receipt') {
      const user = await ensureUser(ctx);
      const driver = await pool.query(`SELECT * FROM drivers WHERE user_id=$1`, [user.id]);
      if (!driver.rows[0]) {
        sessions.delete(ctx.from.id);
        return ctx.reply('Əvvəl qeydiyyat olun. /start');
      }
      await pool.query(
        `INSERT INTO topups(driver_user_id, amount_azn, method, receipt_file_id, status)
         VALUES ($1,$2,$3,$4,'pending')`,
        [user.id, s.data.amount, s.data.method, fileId]
      );
      sessions.delete(ctx.from.id);
      return ctx.reply('✅ Qəbz göndərildi. Admin təsdiq edəndən sonra balansınız artacaq.');
    }
  });

  // After car plate -> request car photo and docs
  bot.on('message', async (ctx, next) => {
    const s = sessions.get(ctx.from.id);
    if (s && s.step === 'car_plate' && ctx.message?.text) {
      // handled by text handler, now set next step
      // (We can't easily hook there, so do nothing)
    }
    return next();
  });

  // Small hook: when user finishes car_plate, ask car photo.
  bot.use(async (ctx, next) => {
    const s = sessions.get(ctx.from.id);
    await next();
    if (!s) return;
    if (s.step === 'car_plate_done') return;
    if (s.step === 'car_plate' && ctx.message?.text) {
      // not reliable
    }
  });

  // Better: after car_plate set, we ask immediately by intercepting text handler above.
  // So we patch by listening to a custom event: we can't. We'll do a simple heuristic:
  bot.hears(/.*/, async (ctx) => {
    const s = sessions.get(ctx.from.id);
    if (!s) return;
    if (s.step === 'car_plate') {
      // if just set in text handler, it moved to another; ignore
      return;
    }
    // When text handler moves from car_plate to (missing) car_photo, it didn't. So we set it here:
    if (s.step === 'doc_start') {
      // no-op
      return;
    }
  });

  // Patch: when car_plate entered, we need to ask car photo.
  // We'll implement by adding an extra hears for plate pattern right after the text handler.
  bot.on('text', async (ctx) => {
    const s = sessions.get(ctx.from.id);
    if (!s) return;
    if (s.step === 'car_photo_prompted') return;
    // If we already have car_plate and next expected is car_photo
    if (s.data.car_plate && s.step !== 'car_photo' && s.step !== 'doc_id_front' && s.step !== 'topup_amount' && s.step !== 'topup_method') {
      // after car_plate is set, text handler already changed step? (it doesn't). So if step is car_plate, ignore.
      if (s.step === 'car_plate') return;
      // If we're after phone/operator/car fields sequence, and car_plate exists, force car_photo
      if (!s.data.car_photo_file_id && ['car_plate','car_make','car_model','operator','phone','surname','name'].includes(s.step) === false) {
        return;
      }
    }
  });

  // Explicit command to continue docs
  bot.command('docs', async (ctx) => {
    const s = sessions.get(ctx.from.id) || { step: 'car_photo', data: {} };
    s.step = 'car_photo';
    sessions.set(ctx.from.id, s);
    return ctx.reply('Avtomobilin şəklini göndərin:');
  });

  // Make sure after car_plate is entered we ask car photo. We do it by overriding the car_plate step in the text handler:
  // (We already have that handler; adding an additional one is messy, but Telegraf executes them in order.
  // We'll keep a final middleware to detect transition.)
  bot.use(async (ctx, next) => {
    const before = sessions.get(ctx.from.id)?.step;
    await next();
    const s = sessions.get(ctx.from.id);
    if (!s) return;
    if (before === 'car_plate' && s.step !== 'car_photo') {
      // The text handler set car_plate, now we move to car_photo
      s.step = 'car_photo';
      await ctx.reply('Avtomobilin şəklini göndərin:');
    }
  });

  await bot.launch();
  console.log('[driverBot] started');
}
