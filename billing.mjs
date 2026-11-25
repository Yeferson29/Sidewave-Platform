import Stripe from 'stripe';
import { randomUUID } from 'node:crypto';
import { creditPacks, plans, eligible } from './dist/content.js';

export function billingFromEnv(env = process.env) {
  const prices = {
    plus: env.STRIPE_PRICE_PLUS, studio: env.STRIPE_PRICE_STUDIO,
    credits25: env.STRIPE_PRICE_CREDITS_25, credits100: env.STRIPE_PRICE_CREDITS_100, credits250: env.STRIPE_PRICE_CREDITS_250
  };
  const key = env.STRIPE_SECRET_KEY;
  const secret = env.STRIPE_WEBHOOK_SECRET;
  if (!key && !secret && Object.values(prices).every(value => !value)) return null;
  if (!key || !secret || !Object.values(prices).every(value => /^price_\w+$/.test(value ?? '')) || new Set(Object.values(prices)).size !== 5) {
    throw new Error('Configure the Stripe API key, webhook secret, and five distinct Price IDs.');
  }
  return { stripe: new Stripe(key, { timeout: 10_000, maxNetworkRetries: 1 }), prices, secret };
}

const listings = [...plans.filter(plan => plan.cents), ...creditPacks];

export function makeBilling({ config, client, accounts, orders, origin, HttpError }) {
  if (!config) return null;
  const { stripe, prices, secret } = config;
  const error = (status, message) => new HttpError(status, message);
  const offerByPrice = new Map(listings.map(item => [prices[item.id], item]));

  async function customerFor(account) {
    if (account.stripeCustomer) return account.stripeCustomer;
    const customer = await stripe.customers.create({ metadata: { tunecloud_account: account._id } },
      { idempotencyKey: 'tunecloud-account-' + account._id });
    const saved = await accounts.findOneAndUpdate({ _id: account._id, stripeCustomer: { $exists: false } },
      { $set: { stripeCustomer: customer.id } }, { returnDocument: 'after' });
    return (saved ?? await accounts.findOne({ _id: account._id })).stripeCustomer;
  }

  async function openCheckout(account, id, requestId) {
    const offer = listings.find(item => item.id === id);
    if (!offer) throw error(400, 'Choose a listed plan or credit pack.');
    const subscription = !offer.credits;
    if (!subscription && (typeof requestId !== 'string' || !/^[a-f0-9-]{36}$/.test(requestId))) {
      throw error(400, 'Start the credit purchase again.');
    }
    const price = await stripe.prices.retrieve(prices[id]);
    if (!price.active || price.unit_amount !== offer.cents || price.currency !== 'usd' ||
        (subscription ? (price.recurring?.interval !== 'month' || price.recurring.interval_count !== 1) : price.type !== 'one_time')) {
      throw error(503, 'Checkout pricing is temporarily unavailable.');
    }
    const customer = await customerFor(account);
    let reservation;
    if (subscription) {
      const existing = await stripe.subscriptions.list({ customer, status: 'all', limit: 100 });
      if (existing.data.some(item => !['canceled', 'incomplete_expired'].includes(item.status))) {
        throw error(409, 'Manage your existing subscription in the billing portal.');
      }
      const fresh = { offer: id, key: randomUUID(), expires: Math.floor(Date.now() / 1000) + 2100 };
      const reserved = await accounts.findOneAndUpdate({ _id: account._id, $or: [
        { pendingSubscription: { $exists: false } }, { 'pendingSubscription.expires': { $lte: Math.floor(Date.now() / 1000) } }
      ] }, { $set: { pendingSubscription: fresh } }, { returnDocument: 'after' });
      reservation = (reserved ?? await accounts.findOne({ _id: account._id })).pendingSubscription;
      if (!reservation || reservation.offer !== id) throw error(409, 'A different plan checkout is open. Resume that checkout or wait for it to expire.');
      if (reservation.sessionId) {
        const previous = await stripe.checkout.sessions.retrieve(reservation.sessionId);
        if (previous.status === 'open' && previous.url) return previous.url;
        throw error(409, 'Your recent checkout is being processed. Refresh billing in a moment.');
      }
      if (reservation.expires - Math.floor(Date.now() / 1000) < 1800) {
        throw error(409, 'An old checkout is expiring. Try again shortly.');
      }
    }
    const checkout = await stripe.checkout.sessions.create({
      customer, client_reference_id: account._id, mode: subscription ? 'subscription' : 'payment',
      line_items: [{ price: prices[id], quantity: 1 }],
      success_url: origin + '/?payment=return#billing', cancel_url: origin + '/#billing',
      ...(subscription ? { expires_at: reservation.expires } : {})
    }, { idempotencyKey: subscription ? 'tunecloud-subscription-' + reservation.key : 'tunecloud-credits-' + account._id + '-' + id + '-' + requestId });
    if (subscription) await accounts.updateOne({ _id: account._id, 'pendingSubscription.key': reservation.key },
      { $set: { 'pendingSubscription.sessionId': checkout.id } });
    return checkout.url;
  }

  async function openPortal(account) {
    if (!account.stripeCustomer) throw error(400, 'Your account has no billing profile yet.');
    const portal = await stripe.billingPortal.sessions.create({ customer: account.stripeCustomer, return_url: origin + '/#billing' });
    return portal.url;
  }

  async function syncPlan(customer) {
    const owner = await accounts.findOneAndUpdate({ stripeCustomer: customer }, { $inc: { billingSequence: 1 } }, { returnDocument: 'after' });
    if (!owner) return;
    let plan = 'free';
    let activeUntil = null;
    for await (const subscription of stripe.subscriptions.list({ customer, status: 'all', limit: 100 })) {
      if (!['active', 'trialing'].includes(subscription.status)) continue;
      for (const item of subscription.items.data) {
        const offer = offerByPrice.get(item.price.id);
        if (!offer || offer.credits || !eligible(offer.id, plan)) continue;
        const expiry = new Date((item.current_period_end ?? subscription.current_period_end ?? 0) * 1000);
        if (expiry <= new Date()) continue;
        activeUntil = plan === offer.id && activeUntil > expiry ? activeUntil : expiry;
        plan = offer.id;
      }
    }
    await accounts.updateOne({ _id: owner._id, billingSequence: owner.billingSequence },
      { $set: { plan, activeUntil } });
  }

  async function fulfillCredits(sessionId) {
    const checkout = await stripe.checkout.sessions.retrieve(sessionId);
    if (checkout.mode !== 'payment' || checkout.status !== 'complete' || checkout.payment_status !== 'paid') return;
    const owner = await accounts.findOne({ _id: checkout.client_reference_id, stripeCustomer: checkout.customer });
    if (!owner) return;
    const items = await stripe.checkout.sessions.listLineItems(sessionId, { limit: 2 });
    const line = items.data[0];
    const offer = line && offerByPrice.get(line.price?.id);
    if (items.data.length !== 1 || items.has_more || line.quantity !== 1 || !offer?.credits ||
        checkout.currency !== 'usd' || checkout.amount_total !== offer.cents) {
      throw new Error('Unrecognized credit checkout. Review the Stripe event.');
    }
    await client.withSession(dbSession => dbSession.withTransaction(async () => {
      const claim = await orders.updateOne({ _id: sessionId }, { $setOnInsert: {
        accountId: owner._id, offer: offer.id, credits: offer.credits, total: checkout.amount_total, currency: checkout.currency, createdAt: new Date()
      } }, { upsert: true, session: dbSession });
      if (claim.upsertedCount) await accounts.updateOne({ _id: owner._id }, { $inc: { credits: offer.credits } }, { session: dbSession });
    }));
  }

  async function webhook(raw, signature) {
    let event;
    try { event = stripe.webhooks.constructEvent(raw, signature, secret); } catch {
      throw error(400, 'Invalid Stripe webhook signature.');
    }
    const object = event.data.object;
    if (['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type)) {
      if (object.mode === 'payment') await fulfillCredits(object.id);
      if (object.mode === 'subscription' && typeof object.customer === 'string') await syncPlan(object.customer);
    }
    if (['customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted'].includes(event.type) && typeof object.customer === 'string') {
      await syncPlan(object.customer);
    }
    if (event.type === 'checkout.session.expired' && object.mode === 'subscription') {
      await accounts.updateOne({ stripeCustomer: object.customer, 'pendingSubscription.sessionId': object.id }, { $unset: { pendingSubscription: '' } });
    }
  }

  return { openCheckout, openPortal, webhook };
}
