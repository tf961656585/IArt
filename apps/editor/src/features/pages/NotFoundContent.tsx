import Link from "next/link";
import { ArrowRight, Compass, Home, LifeBuoy } from "lucide-react";

type ActionLink = {
  href: string;
  label: string;
};

interface NotFoundContentProps {
  title: string;
  description: string;
  primaryAction: ActionLink;
  secondaryAction: ActionLink;
  suggestionsLabel: string;
  quickLinks: ReadonlyArray<ActionLink>;
}

const NotFoundContent = ({
  title,
  description,
  primaryAction,
  secondaryAction,
  suggestionsLabel,
  quickLinks,
}: NotFoundContentProps) => {
  return (
    <section className="relative isolate flex min-h-[70vh] items-center justify-center bg-gradient-to-b from-background via-background to-muted/60 px-4 py-12 sm:px-6 lg:px-8">
      <div
        className="absolute inset-x-10 top-16 -z-10 h-40 rounded-full bg-primary/10 blur-3xl dark:bg-primary/20"
        aria-hidden
      />

      <div className="w-full max-w-4xl overflow-hidden rounded-2xl border border-border/70 bg-card/80 shadow-xl backdrop-blur">
        <div className="flex flex-col gap-6 px-6 py-10 sm:px-10">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-primary">
            <Compass className="size-4" aria-hidden />
            <span>404</span>
          </div>

          <div className="space-y-3">
            <h1 className="text-3xl font-semibold leading-tight sm:text-4xl">{title}</h1>
            <p className="text-base text-muted-foreground sm:text-lg">{description}</p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Link
              href={primaryAction.href}
              className="inline-flex items-center justify-center gap-2 rounded-md bg-primary px-6 py-2.5 text-sm font-medium text-primary-foreground transition hover:bg-primary/90"
            >
              <Home className="size-4" aria-hidden />
              {primaryAction.label}
            </Link>
            <Link
              href={secondaryAction.href}
              className="inline-flex items-center justify-center gap-2 rounded-md border bg-background px-6 py-2.5 text-sm font-medium shadow-xs transition hover:bg-accent hover:text-accent-foreground"
            >
              <LifeBuoy className="size-4" aria-hidden />
              {secondaryAction.label}
            </Link>
          </div>

          <div className="mt-2 space-y-3">
            <p className="text-sm font-semibold text-muted-foreground">{suggestionsLabel}</p>
            <div className="grid gap-3 sm:grid-cols-2">
              {quickLinks.map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  className="group flex items-center justify-between rounded-lg border border-border/60 bg-muted/50 px-4 py-3 transition hover:-translate-y-0.5 hover:border-primary/60 hover:bg-primary/5"
                >
                  <span className="font-medium text-foreground">{link.label}</span>
                  <ArrowRight
                    className="size-4 text-muted-foreground transition group-hover:translate-x-1 group-hover:text-primary"
                    aria-hidden
                  />
                </Link>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};

export default NotFoundContent;
