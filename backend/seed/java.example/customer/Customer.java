package com.acme.shop.customer;

/** Who is ordering. Inactive customers stay in the system — orders of theirs do not. */
public final class Customer {

    private final String id;
    private final String name;
    private final boolean active;

    public Customer(String id, String name, boolean active) {
        this.id = id;
        this.name = name;
        this.active = active;
    }

    public String id() {
        return id;
    }

    public String name() {
        return name;
    }

    public boolean isActive() {
        return active;
    }
}
