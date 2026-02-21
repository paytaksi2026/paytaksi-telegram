import Stripe from "stripe";

let stripe = null;

export function stripeEnabled(){
  return !!process.env.STRIPE_SECRET_KEY;
}

export function getStripe(){
  if(stripe) return stripe;
  if(!process.env.STRIPE_SECRET_KEY) return null;
  stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });
  return stripe;
}
