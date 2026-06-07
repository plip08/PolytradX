'use client';

import React from 'react';

interface Props {
  children: React.ReactNode;
  label?: string;
}

interface State {
  hasError: boolean;
  error?: Error;
}

export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  render(): React.ReactNode {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center h-64 gap-4 text-slate-500">
          <div className="text-5xl">⚠️</div>
          <div className="text-center">
            <p className="text-sm text-red-400 font-semibold">
              {this.props.label ?? 'This panel'} has crashed
            </p>
            {this.state.error?.message && (
              <p className="text-xs text-slate-600 font-mono mt-1 max-w-sm">
                {this.state.error.message}
              </p>
            )}
          </div>
          <button
            onClick={() => this.setState({ hasError: false, error: undefined })}
            className="px-4 py-1.5 text-xs rounded-lg bg-slate-800 border border-slate-700 text-slate-300 hover:border-slate-500 transition-all"
          >
            Try again
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
