/* eslint-disable react-refresh/only-export-components */
import { Suspense, lazy, type ReactNode } from "react";
import { createHashRouter, Outlet } from "react-router-dom";
import RootLayout from "@/layouts/RootLayout";
import { ViewTransitionProvider } from "@/components/core/view-transition";
import { Toaster } from "@/components/ui/sonner";
import { Skeleton } from "@/components/ui/skeleton";
import { SplashScreen } from "@/pages";

const LLMConfigPage = lazy(() => import("@/pages/LLMConfig"));
const HomePage = lazy(() => import("@/pages/Home"));
const SettingsPage = lazy(() => import("@/pages/Settings"));
const SettingsLLMConfigPage = lazy(() => import("@/pages/SettingsLLMConfig"));
const CaptureSourceSettingsPage = lazy(() => import("@/pages/settings/CaptureSourceSettings"));
const UsagePage = lazy(() => import("@/pages/settings/UsagePage"));
const SearchResultsPage = lazy(() => import("@/pages/SearchResults"));
const NotFoundPage = lazy(() => import("@/pages/NotFound"));

function PageShellSkeleton() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <main className="container mx-auto px-4 py-6">
        <div className="space-y-4">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-4 w-96" />
          <Skeleton className="h-[420px] w-full rounded-xl" />
        </div>
      </main>
    </div>
  );
}

function HomePageSkeleton() {
  return (
    <div className="h-[calc(100vh-88px)] flex flex-col items-center justify-center -mt-22 px-2">
      <Skeleton className="h-10 w-full max-w-4xl rounded-xl opacity-50" />
    </div>
  );
}

function SettingsPageSkeleton() {
  return (
    <div className="max-w-2xl mx-auto space-y-8">
      <div className="space-y-3">
        <Skeleton className="h-10 w-56" />
        <Skeleton className="h-4 w-80" />
      </div>
      <div className="space-y-4">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-16 w-full rounded-xl" />
        ))}
      </div>
    </div>
  );
}

function LLMConfigPageSkeleton() {
  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div className="space-y-3">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-4 w-96" />
      </div>
      <div className="space-y-4">
        <Skeleton className="h-10 w-48" />
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-11 w-full rounded-md" />
        ))}
        <Skeleton className="h-10 w-32" />
      </div>
    </div>
  );
}

function CaptureSourceSettingsPageSkeleton() {
  return (
    <div className="space-y-8">
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <Skeleton className="h-7 w-24" />
          <div className="flex gap-2">
            <Skeleton className="h-9 w-24" />
            <Skeleton className="h-9 w-28" />
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 2 }).map((_, i) => (
            <Skeleton key={i} className="h-48 rounded-lg" />
          ))}
        </div>
      </div>
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <Skeleton className="h-7 w-28" />
          <div className="flex gap-2">
            <Skeleton className="h-9 w-24" />
            <Skeleton className="h-9 w-28" />
          </div>
        </div>
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-14 rounded-md" />
          ))}
        </div>
      </div>
    </div>
  );
}

function UsagePageSkeleton() {
  return (
    <div className="max-w-4xl mx-auto space-y-6 pb-10">
      <div className="flex items-center gap-4">
        <Skeleton className="h-10 w-10 rounded-md" />
        <div className="space-y-2">
          <Skeleton className="h-9 w-56" />
          <Skeleton className="h-4 w-72" />
        </div>
        <div className="ml-auto">
          <Skeleton className="h-9 w-28 rounded-md" />
        </div>
      </div>
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-28 w-full rounded-lg" />
        ))}
      </div>
      <Skeleton className="w-full h-[300px] rounded-lg" />
      <Skeleton className="w-full h-[200px] rounded-lg" />
    </div>
  );
}

function SearchResultsPageSkeleton() {
  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <Skeleton className="h-10 w-10 rounded-md" />
        <div className="space-y-2">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-4 w-96" />
        </div>
      </div>
      <div className="space-y-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-20 w-full rounded-lg" />
        ))}
      </div>
    </div>
  );
}

function withSuspense(node: ReactNode, fallback: ReactNode) {
  return <Suspense fallback={fallback}>{node}</Suspense>;
}

function AppRoot() {
  return (
    <ViewTransitionProvider>
      <Outlet />
      <Toaster closeButton richColors />
    </ViewTransitionProvider>
  );
}

export const router = createHashRouter([
  {
    element: <AppRoot />,
    children: [
      {
        path: "/splash",
        element: <SplashScreen />,
      },
      {
        path: "/llm-config",
        element: withSuspense(
          <LLMConfigPage />,
          <div className="min-h-screen bg-background flex items-center justify-center p-8">
            <LLMConfigPageSkeleton />
          </div>
        ),
      },
      {
        path: "/",
        element: <RootLayout />,
        children: [
          {
            index: true,
            element: withSuspense(<HomePage />, <HomePageSkeleton />),
          },
          {
            path: "settings",
            element: withSuspense(<SettingsPage />, <SettingsPageSkeleton />),
          },
          {
            path: "settings/llm-config",
            element: withSuspense(<SettingsLLMConfigPage />, <LLMConfigPageSkeleton />),
          },
          {
            path: "settings/capture-sources",
            element: withSuspense(
              <CaptureSourceSettingsPage />,
              <CaptureSourceSettingsPageSkeleton />
            ),
          },
          {
            path: "settings/usage",
            element: withSuspense(<UsagePage />, <UsagePageSkeleton />),
          },
          {
            path: "search-results",
            element: withSuspense(<SearchResultsPage />, <SearchResultsPageSkeleton />),
          },
          {
            path: "*",
            element: withSuspense(<NotFoundPage />, <PageShellSkeleton />),
          },
        ],
      },
    ],
  },
]);
