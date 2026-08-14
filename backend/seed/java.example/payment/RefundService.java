package com.acme.shop.payment;

import com.acme.shop.util.Money;

/**
 * Giving money back. Separate from {@link PaymentGateway} because a refund is a decision,
 * while the gateway only carries it out.
 *
 * It takes a reference and an amount, not an order: payment knows nothing about orders,
 * and keeping it that way is what stops the two packages from depending on each other.
 */
public class RefundService {

    private final PaymentGateway gateway;

    public RefundService(PaymentGateway gateway) {
        this.gateway = gateway;
    }

    public PaymentResult refund(String reference, Money amount) {
        if (amount.isZero()) {
            throw new IllegalStateException("Nothing to refund");
        }
        return gateway.refund(reference, amount);
    }
}
