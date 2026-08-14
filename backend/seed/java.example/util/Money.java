package com.acme.shop.util;

/**
 * A minor-unit amount with a currency. Immutable: every operation returns a new value,
 * so an amount can be passed around without anyone changing it behind your back.
 */
public final class Money {

    private final long cents;
    private final String currency;

    private Money(long cents, String currency) {
        this.cents = cents;
        this.currency = currency;
    }

    /** The only way in — the constructor stays private so no half-built amount escapes. */
    public static Money of(long cents, String currency) {
        if (currency == null || currency.isEmpty()) {
            throw new IllegalArgumentException("A currency is required");
        }
        return new Money(cents, currency);
    }

    public Money plus(Money other) {
        if (!currency.equals(other.currency)) {
            throw new IllegalArgumentException("Cannot add " + other.currency + " to " + currency);
        }
        return new Money(cents + other.cents, currency);
    }

    public Money times(int factor) {
        return new Money(cents * factor, currency);
    }

    public long amount() {
        return cents;
    }

    public boolean isZero() {
        return cents == 0L;
    }

    @Override
    public String toString() {
        return (cents / 100) + "." + String.format("%02d", Math.abs(cents % 100)) + " " + currency;
    }
}
