package com.acme.shop.order;

import com.acme.shop.util.Money;

/** One product on an order: what it is, how many, and at which price it was added. */
public final class OrderLine {

    private final String productId;
    private final int quantity;
    private final Money unitPrice;

    public OrderLine(String productId, int quantity, Money unitPrice) {
        this.productId = productId;
        this.quantity = quantity;
        this.unitPrice = unitPrice;
    }

    /**
     * The price is stored per line and not looked up again: what the customer saw when
     * ordering is what the customer pays, even if the catalog changes tomorrow.
     */
    public Money total() {
        return unitPrice.times(quantity);
    }

    public int quantity() {
        return quantity;
    }
}
