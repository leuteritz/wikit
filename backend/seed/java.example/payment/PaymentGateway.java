package com.acme.shop.payment;

import com.acme.shop.util.Money;

/**
 * The edge towards the payment provider. Stubbed here — what matters for the graph is
 * that only this class talks outward, and everyone else talks to it.
 */
public class PaymentGateway {

    private static final long LIMIT_CENTS = 500_000L;

    public PaymentResult charge(String customerId, Money amount) {
        if (amount.amount() > LIMIT_CENTS) {
            return new PaymentResult(false, "limit-exceeded", amount);
        }
        return new PaymentResult(true, "PAY-" + customerId + "-" + amount.amount(), amount);
    }

    public PaymentResult refund(String reference, Money amount) {
        return new PaymentResult(true, "REF-" + reference, amount);
    }
}
