// assets/modules/pricing.js

/**
 * Silnik Cenowy Marketplace'u
 * @param {number} publicPrice - Cena bazowa ustalona przez partnera (np. 100 EUR)
 * @param {number} partnerDiscountPercent - Rabat jakiego partner udziela platformie (np. 10%)
 * @param {number} platformMarginPercent - Marża platformy narzucana na cenę netto (domyślnie 25%)
 * @returns {object} - Kompletny model cenowy (Snapshot)
 */
export function calculatePricing(publicPrice, partnerDiscountPercent = 0, platformMarginPercent = 25) {
    // 1. Cena netto dla partnera (Cena publiczna minus rabat partnera)
    const partnerNetPrice = publicPrice * (1 - (partnerDiscountPercent / 100));

    // 2. Ostateczna cena dla klienta (Cena netto partnera + marża platformy 25%)
    const finalCustomerPrice = partnerNetPrice * (1 + (platformMarginPercent / 100));

    // 3. Nasza prowizja (To, co klient płaci online podczas rezerwacji)
    const commission = finalCustomerPrice - partnerNetPrice;

    return {
        publicPrice: parseFloat(publicPrice.toFixed(2)),
        partnerDiscount: partnerDiscountPercent,
        partnerNetPrice: parseFloat(partnerNetPrice.toFixed(2)),
        platformMargin: platformMarginPercent,
        finalPrice: parseFloat(finalCustomerPrice.toFixed(2)),
        commission: parseFloat(commission.toFixed(2))
    };
}