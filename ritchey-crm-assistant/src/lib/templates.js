import { money, escapeHtml } from './format.js';

// "*10 Day: MGR | Send Out Price" — built as a list of paragraphs, then
// rendered to both HTML (bold survives paste into VinSolutions) and plain text.
//
// A paragraph is an array of segments: { t: 'text', b: true|false }.
// A paragraph with `lines: true` renders its segments' '\n' as <br>.

const S = (t, b = false) => ({ t, b });

const COPY = {
  en: {
    hi: (n) => `Hi ${n || '[Customer First Name]'},`,
    thanksFirst: (v) => `Thank you for your interest in the ${v}.`,
    thanksFollow: (v) => `Thank you for your continued interest in the ${v}.`,
    iAm: (s) => `I’m ${s.firstName}, the ${s.title} here at ${s.dealership}.`,
    value: 'We value the opportunity to earn your business and want to make it as easy as possible for you to move forward.',
    putTogether: ['I’ve put together ', 'Manager Special pricing', ' for you on this vehicle:'],
    labels: {
      stock: 'Stock #: ',
      asking: 'MSRP / Asking Price: ',
      discount: 'Manager Discount: ',
      special: 'Your Manager Special Price: ',
      withFees: 'Our Price with Fees: ',
    },
    reply: (s) =>
      `If the vehicle and pricing make sense, reply to this email or call/text me at ${s.phone}. I’ll personally make sure everything is ready and make the process as quick and easy as possible.`,
    close: 'When would be a good time for you to stop by—today or tomorrow?',
    thankYou: 'Thank you,',
    soldIntro: 'Unfortunately, that vehicle has already sold — but I don’t want you to miss out. Here are a few similar options we have available right now:',
    soldReply: (s) =>
      `If any of these look good, or you’d like me to keep an eye out for something specific, reply to this email or call/text me at ${s.phone}.`,
    subjectQuote: (v) => `Manager Special pricing on the ${v}`,
    subjectAlt: (v) => `About the ${v} — a few similar options`,
    smsQuote: (n, s, v, p) =>
      `Hi ${n}, this is ${s.firstName}, ${s.title} at ${s.dealership}. I reviewed the ${v} you’re interested in and put together special manager pricing of ${p} for you. Do you have a few minutes to connect today?`,
    smsQuoteFollow: (n, s, v, p) =>
      `Hi ${n}, it’s ${s.firstName}, ${s.title} at ${s.dealership}, following up on the ${v}. I put together special manager pricing of ${p} for you. Do you have a few minutes to connect today?`,
    smsAlt: (n, s, v) =>
      `Hi ${n}, this is ${s.firstName}, ${s.title} at ${s.dealership}. The ${v} you asked about just sold, but I have a few similar ones I’d love to show you. Do you have a few minutes to connect today?`,
    smsAltOne: (n, s, v, title, link) =>
      `Hi ${n}, this is ${s.firstName}, ${s.title} at ${s.dealership}. The ${v} you asked about just sold, but we have a ${title} that I think you’ll like even more${link ? `: ${link}` : '.'} Do you have a few minutes to connect today?`,
    miles: 'miles',
  },
  es: {
    hi: (n) => `Hola ${n || '[Nombre del Cliente]'},`,
    thanksFirst: (v) => `Gracias por su interés en el ${v}.`,
    thanksFollow: (v) => `Gracias por su interés continuo en el ${v}.`,
    iAm: (s) => `Soy ${s.firstName}, ${s.titleEs} aquí en ${s.dealership}.`,
    value: 'Valoramos la oportunidad de ganarnos su confianza y queremos que el proceso sea lo más fácil posible para usted.',
    putTogether: ['He preparado un ', 'precio especial de gerente', ' para usted en este vehículo:'],
    labels: {
      stock: 'Stock #: ',
      asking: 'MSRP / Precio de lista: ',
      discount: 'Descuento del gerente: ',
      special: 'Su precio especial de gerente: ',
      withFees: 'Nuestro precio con cargos: ',
    },
    reply: (s) =>
      `Si el vehículo y el precio le parecen bien, responda a este correo o llámeme / envíeme un mensaje de texto al ${s.phone}. Personalmente me aseguraré de que todo esté listo y de que el proceso sea rápido y sencillo.`,
    close: '¿Cuándo le queda bien pasar por aquí, hoy o mañana?',
    thankYou: 'Gracias,',
    soldIntro: 'Lamentablemente, ese vehículo ya se vendió — pero no quiero que se quede sin opciones. Estas son algunas alternativas similares que tenemos disponibles ahora mismo:',
    soldReply: (s) =>
      `Si alguna le interesa, o si quiere que le avise cuando llegue algo en específico, responda a este correo o llámeme / envíeme un mensaje de texto al ${s.phone}.`,
    subjectQuote: (v) => `Precio especial de gerente para el ${v}`,
    subjectAlt: (v) => `Sobre el ${v} — algunas opciones similares`,
    smsQuote: (n, s, v, p) =>
      `Hola ${n}, soy ${s.firstName}, ${s.titleEs} en ${s.dealership}. Revisé el ${v} que le interesa y le preparé un precio especial de gerente de ${p}. ¿Tiene unos minutos para hablar hoy?`,
    smsQuoteFollow: (n, s, v, p) =>
      `Hola ${n}, soy ${s.firstName}, ${s.titleEs} en ${s.dealership}, dando seguimiento sobre el ${v}. Le preparé un precio especial de gerente de ${p}. ¿Tiene unos minutos para hablar hoy?`,
    smsAlt: (n, s, v) =>
      `Hola ${n}, soy ${s.firstName}, ${s.titleEs} en ${s.dealership}. El ${v} que le interesaba ya se vendió, pero tengo algunos similares que me encantaría mostrarle. ¿Tiene unos minutos para hablar hoy?`,
    smsAltOne: (n, s, v, title, link) =>
      `Hola ${n}, soy ${s.firstName}, ${s.titleEs} en ${s.dealership}. El ${v} que le interesaba ya se vendió, pero tenemos un ${title} que creo que le va a gustar aún más${link ? `: ${link}` : '.'} ¿Tiene unos minutos para hablar hoy?`,
    miles: 'millas',
  },
};

function signature(s) {
  return {
    lines: true,
    segs: [S(`${s.myName} | ${s.title}`, true), S(`\n${s.dealership}\n998 North Nova Rd.\nDaytona Beach, FL 32117\nOffice: ${s.phone}`)],
  };
}

function pricingBlock(c, stock, p) {
  const L = c.labels;
  return {
    lines: true,
    segs: [
      S(L.stock), S(stock || '', true), S('\n\n'),
      S(L.asking), S(money(p.asking), true), S('\n'),
      S(L.discount), S(`-${money(p.discount)}`, true), S('\n'),
      S(`${L.special}${money(p.special)}`, true), S('\n'),
      S(`${L.withFees}${money(p.withFees)}`, true),
    ],
  };
}

function altBlock(alts, c) {
  const segs = [];
  alts.forEach((a, i) => {
    if (i) segs.push(S('\n'));
    segs.push(S('• '), S(a.title || 'Vehicle', true));
    if (a.miles) segs.push(S(` — ${Number(a.miles).toLocaleString('en-US')} ${c.miles}`));
    if (a.stock) segs.push(S(` — Stock # ${a.stock}`));
    if (a.price) segs.push(S(' — '), S(money(a.price), true));
    if (a.link) segs.push(S('\n   '), { t: a.link, link: a.link });
  });
  return { lines: true, segs };
}

function renderHtml(paras) {
  return paras
    .map((p) => {
      const inner = p.segs
        .map((s) => {
          const t = escapeHtml(s.t).replace(/\n/g, '<br>');
          if (s.link) return `<a href="${escapeHtml(s.link)}">${t}</a>`;
          return s.b ? `<b>${t}</b>` : t;
        })
        .join('');
      return `<p>${inner}</p>`;
    })
    .join('\n');
}

function renderText(paras) {
  return paras.map((p) => p.segs.map((s) => s.t).join('')).join('\n\n');
}

export function buildDrafts({ mode, lang = 'en', customer, vehicleTitle, stock, pricing, alternatives = [], settings, followUp = false }) {
  const c = COPY[lang] || COPY.en;
  const s = settings;
  const v = vehicleTitle || (lang === 'es' ? 'vehículo' : 'vehicle');
  const first = customer?.firstName || '';

  const paras = [{ segs: [S(c.hi(first))] }];
  paras.push({ segs: [S(`${followUp ? c.thanksFollow(v) : c.thanksFirst(v)} ${c.iAm(s)}`)] });

  let sms;
  let subject;
  if (mode === 'quote') {
    if (!pricing) throw new Error('Pricing is required for a quote.');
    paras.push({ segs: [S(c.value)] });
    paras.push({ segs: [S(c.putTogether[0]), S(c.putTogether[1], true), S(c.putTogether[2])] });
    paras.push(pricingBlock(c, stock, pricing));
    paras.push({ segs: [S(c.reply(s))] });
    subject = c.subjectQuote(v);
    const smsPrice = money(s.textPriceField === 'withFees' ? pricing.withFees : pricing.special);
    sms = (followUp ? c.smsQuoteFollow : c.smsQuote)(first || '[Customer First Name]', s, v, smsPrice);
  } else if (mode === 'alternatives') {
    paras.push({ segs: [S(c.soldIntro)] });
    if (alternatives.length) paras.push(altBlock(alternatives, c));
    paras.push({ segs: [S(c.soldReply(s))] });
    subject = c.subjectAlt(v);
    if (alternatives.length === 1) {
      // One vehicle to offer: name it and link it right in the text.
      const a = alternatives[0];
      sms = c.smsAltOne(first || '[Customer First Name]', s, v, a.title || 'vehicle', a.link || '');
    } else {
      sms = c.smsAlt(first || '[Customer First Name]', s, v);
    }
  } else {
    throw new Error(`No draft for mode "${mode}".`);
  }

  paras.push({ segs: [S(c.close, true)] });
  paras.push({ segs: [S(c.thankYou)] });
  if (s.includeSignature) paras.push(signature(s));

  return {
    subject,
    emailHtml: renderHtml(paras),
    emailText: renderText(paras),
    sms,
  };
}
