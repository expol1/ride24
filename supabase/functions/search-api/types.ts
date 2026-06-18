export interface ProviderConfig {

    provider: string;

    settings: any;

}

export interface SearchFilters {

    pickupLocation: string;

    dropoffLocation: string;

    pickupDate: string;

    returnDate: string;

    pickupTime?: string;

    returnTime?: string;

}

export interface ProviderResult {

    success: boolean;

    cars: any[];

    error?: string;

}