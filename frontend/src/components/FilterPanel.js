import React from 'react';
import { Filter, X } from 'lucide-react';
import { Button } from './components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './components/ui/select';
import { Input } from './components/ui/input';
import { Label } from './components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from './components/ui/popover';

class FilterPanel extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      isOpen: false,
      minSavings: props.filters?.minSavings || 0,
      capacityType: props.filters?.capacityType || 'all',
      architecture: props.filters?.architecture || 'all',
      instanceFamily: props.filters?.instanceFamily || '',
    };
  }

  handleFilterChange = (key, value) => {
    this.setState({ [key]: value });
  };

  applyFilters = () => {
    this.props.onFilterChange(this.state);
    this.setState({ isOpen: false });
  };

  clearFilters = () => {
    const defaultFilters = {
      minSavings: 0,
      capacityType: 'all',
      architecture: 'all',
      instanceFamily: '',
    };
    this.setState(defaultFilters);
    this.props.onFilterChange(defaultFilters);
    this.setState({ isOpen: false });
  };

  hasActiveFilters = () => {
    return (
      this.state.minSavings > 0 ||
      this.state.capacityType !== 'all' ||
      this.state.architecture !== 'all' ||
      this.state.instanceFamily !== ''
    );
  };

  render() {
    const { isOpen, minSavings, capacityType, architecture, instanceFamily } = this.state;
    const activeCount = this.hasActiveFilters() ? 1 : 0;

    return (
      <Popover open={isOpen} onOpenChange={(open) => this.setState({ isOpen: open })}>
        <PopoverTrigger asChild>
          <Button variant="outline" className="flex items-center gap-2">
            <Filter className="w-4 h-4" />
            Filters
            {activeCount > 0 && (
              <span className="bg-blue-600 text-white text-xs rounded-full px-2 py-0.5">
                {activeCount}
              </span>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-80" align="start">
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold">Filter Recommendations</h3>
              <Button variant="ghost" size="sm" onClick={() => this.setState({ isOpen: false })}>
                <X className="w-4 h-4" />
              </Button>
            </div>

            <div className="space-y-2">
              <Label htmlFor="minSavings">Minimum Savings ($/hr)</Label>
              <Input
                id="minSavings"
                type="number"
                min="0"
                step="0.01"
                value={minSavings}
                onChange={(e) =>
                  this.handleFilterChange('minSavings', parseFloat(e.target.value) || 0)
                }
                placeholder="0"
              />
            </div>

            <div className="space-y-2">
              <Label>Capacity Type</Label>
              <Select
                value={capacityType}
                onValueChange={(value) => this.handleFilterChange('capacityType', value)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="All" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Types</SelectItem>
                  <SelectItem value="spot">Spot</SelectItem>
                  <SelectItem value="on-demand">On-Demand</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Architecture</Label>
              <Select
                value={architecture}
                onValueChange={(value) => this.handleFilterChange('architecture', value)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="All" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Architectures</SelectItem>
                  <SelectItem value="amd64">AMD64</SelectItem>
                  <SelectItem value="arm64">ARM64</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Instance Family</Label>
              <Input
                value={instanceFamily}
                onChange={(e) => this.handleFilterChange('instanceFamily', e.target.value)}
                placeholder="e.g., m6i, t3, c5"
              />
            </div>

            <div className="flex gap-2 pt-2">
              <Button onClick={this.applyFilters} className="flex-1">
                Apply Filters
              </Button>
              <Button variant="outline" onClick={this.clearFilters}>
                Clear
              </Button>
            </div>
          </div>
        </PopoverContent>
      </Popover>
    );
  }
}

export default FilterPanel;
