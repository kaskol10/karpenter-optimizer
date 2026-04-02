import React, { useState } from 'react';
import { Download, FileJson, FileCode, FileText } from 'lucide-react';
import { Button } from './components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './components/ui/dropdown-menu';
import {
  exportToJSON,
  exportToYAML,
  exportToKarpenterManifest,
  generateSummary,
} from '../lib/export';
import { logger } from '../lib/logger';

function ExportButton({ recommendations, disabled }) {
  const [isExporting, setIsExporting] = useState(false);

  const handleExport = async (exportFn, filename) => {
    if (disabled || !recommendations || recommendations.length === 0) {
      return;
    }

    setIsExporting(true);
    try {
      exportFn(recommendations, filename);
    } catch (error) {
      logger.error('Export failed:', error);
    } finally {
      setIsExporting(false);
    }
  };

  const summary = generateSummary(recommendations || []);

  if (disabled || !recommendations || recommendations.length === 0) {
    return (
      <Button variant="outline" disabled className="flex items-center gap-2">
        <Download className="w-4 h-4" />
        Export
      </Button>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" className="flex items-center gap-2">
          <Download className="w-4 h-4" />
          Export
          {summary.totalSavings > 0 && (
            <span className="text-green-600 text-xs ml-1">
              Save ${summary.totalSavings.toFixed(2)}/hr
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          onClick={() => handleExport(exportToJSON, 'recommendations.json')}
          disabled={isExporting}
        >
          <FileJson className="w-4 h-4 mr-2" />
          Export as JSON
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => handleExport(exportToYAML, 'recommendations.yaml')}
          disabled={isExporting}
        >
          <FileCode className="w-4 h-4 mr-2" />
          Export as YAML
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() => handleExport(exportToKarpenterManifest, 'karpenter-nodepools.yaml')}
          disabled={isExporting}
        >
          <FileText className="w-4 h-4 mr-2" />
          Export as Karpenter Manifest
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export default ExportButton;
