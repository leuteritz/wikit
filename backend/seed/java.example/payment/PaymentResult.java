package com.acme.shop.payment;

import com.acme.shop.util.Money;

/**
 * What the gateway answered. A declined payment is a normal outcome, not an error —
 * hence a result object and not an exception.
 */
public final class PaymentResult {

    private final boolean accepted;
    private final String reference;
    private final Money amount;

    public PaymentResult(boolean accepted, String reference, Money amount) {
        this.accepted = accepted;
        this.reference = reference;
        this.amount = amount;
    }

    public boolean isAccepted() {
        return accepted;
    }

    public String reference() {
        return reference;
    }

    public Money amount() {
        return amount;
    }
}
