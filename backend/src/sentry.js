import * as Sentry from "@sentry/node";

export function initSentry(app){
  const dsn = process.env.SENTRY_DSN;
  if(!dsn) return false;

  Sentry.init({
    dsn,
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE || "0.05"),
    environment: process.env.SENTRY_ENV || process.env.NODE_ENV || "production",
  });

  if(app){
    app.use(Sentry.Handlers.requestHandler());
    app.use(Sentry.Handlers.tracingHandler());
  }
  return true;
}

export function sentryErrorHandler(app){
  try{ app.use(Sentry.Handlers.errorHandler()); }catch(e){}
}
