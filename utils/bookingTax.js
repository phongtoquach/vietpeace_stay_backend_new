function inferBookingTaxRatePercent(booking) {
    const { rooms_subtotal, extra_guest_total, tax_amount } = booking;

    console.log("[inferBookingTaxRatePercent] Value cua rooms_subtotal : ", rooms_subtotal);
    console.log("[inferBookingTaxRatePercent] Value cua extra_guest_total : ", extra_guest_total);
    console.log("[inferBookingTaxRatePercent] Value cua tax_amount : ", tax_amount);

    if (rooms_subtotal == null || extra_guest_total == null || tax_amount == null) {
        return null;
    }

    const taxableAmount = Number(rooms_subtotal) + Number(extra_guest_total);
    const taxAmount = Number(tax_amount);

    if (
        !Number.isFinite(taxableAmount) ||
        !Number.isFinite(taxAmount) ||
        taxableAmount <= 0 ||
        taxAmount < 0
    ) {
        return null;
    }

    // 800 basis points = 8%. Làm tròn đến 0,01 điểm phần trăm.
    const taxBps = Math.round((taxAmount / taxableAmount) * 10000);
    console.log("[inferBookingTaxRatePercent] taxBps tinh ra la : ", taxBps);

    return taxBps / 100;
}


module.exports = { inferBookingTaxRatePercent };