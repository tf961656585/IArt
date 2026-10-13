"use client";

import { cn } from "@/lib/utils";
import React from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

interface Links {
  label: string;
  href: string;
  icon: React.JSX.Element | React.ReactNode;
}

export const Sidebar = ({ children }: { children: React.ReactNode }) => {
  return <>{children}</>;
};

export const SidebarBody = ({
  className,
  children,
  ...props
}: React.ComponentProps<"div">) => {
  return (
    <div
      className={cn(
        "h-full px-4 py-4 flex flex-col bg-neutral-100 dark:bg-neutral-800 w-[60px] shrink-0",
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
};

export const SidebarLink = ({
  link,
  className,
  ...props
}: {
  link: Links;
  className: string | undefined;
} & React.ComponentProps<"a">) => {
  const content = (
    <a
      href={link.href}
      aria-label={link.label}
      className={cn(
        "flex items-center justify-start gap-2 group/sidebar py-2 rounded-md px-2 transition-colors",
        "hover:bg-accent/60 text-foreground/80",
        className
      )}
      {...props}
    >
      {link.icon}
    </a>
  );

  return (
    <Tooltip>
      <TooltipTrigger asChild>{content}</TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}>
        {link.label}
      </TooltipContent>
    </Tooltip>
  );
};
