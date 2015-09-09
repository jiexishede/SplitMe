'use strict';

var Immutable = require('immutable');

var polyglot = require('polyglot');
var expenseUtils = require('Main/Expense/utils');

var accountUtils = {
  getMemberBalanceEntry: function(member, currency) {
    return member.get('balances').findEntry(function(value) {
      return value.get('currency') === currency;
    });
  },
  getNameMember: function(member) {
    if (member.get('id') === '0') {
      return polyglot.t('me');
    } else {
      // add displayName for backward compatibility
      return member.get('name') || member.get('displayName');
    }
  },
  getNameAccount: function(account) {
    var name = account.get('name');

    if (name === '') {
      for (var i = 1; i < Math.min(account.get('members').size, 4); i++) {
        name += account.getIn(['members', i, 'name']) + ', ';
      }
      name = name.substring(0, name.length - 2);
    }

    return name;
  },
  getMemberBalance: function(member, currency) {
    return member.get('balances').find(function(item) {
        return item.get('currency') === currency;
      });
  },
  getAccountMember: function(account, memberId) {
    return account.get('members').findEntry(function(value) {
      return value.get('id') === memberId;
    });
  },
  applyTransfersToAccount: function(account, transfers, inverse) {
    if (!inverse) {
      inverse = false; // Boolean
    }

    function addEmptyBalanceToAccount(currency, list) {
      return list.push(Immutable.fromJS({
        currency: currency,
        value: 0,
      }));
    }

    function updateValue(toAdd, number) {
      return number + toAdd;
    }

    return account.withMutations(function(accountMutable) {
      for (var i = 0; i < transfers.length; i++) {
        var transfer = transfers[i];

        var memberFrom = accountUtils.getAccountMember(accountMutable, transfer.from);
        var memberTo = accountUtils.getAccountMember(accountMutable, transfer.to);

        var memberFromBalance = accountUtils.getMemberBalanceEntry(memberFrom[1], transfer.currency);

        if (!memberFromBalance) {
          accountMutable.updateIn(['members', memberFrom[0], 'balances'],
            addEmptyBalanceToAccount.bind(this, transfer.currency));
          memberFrom = accountUtils.getAccountMember(accountMutable, transfer.from);
          memberFromBalance = accountUtils.getMemberBalanceEntry(memberFrom[1], transfer.currency);
        }

        var memberToBalance = accountUtils.getMemberBalanceEntry(memberTo[1], transfer.currency);

        if (!memberToBalance) {
          accountMutable.updateIn(['members', memberTo[0], 'balances'],
            addEmptyBalanceToAccount.bind(this, transfer.currency));
          memberTo = accountUtils.getAccountMember(accountMutable, transfer.to);
          memberToBalance = accountUtils.getMemberBalanceEntry(memberTo[1], transfer.currency);
        }

        var memberFromBalanceToAdd;
        var memberToBalanceToAdd;

        if (inverse === false) {
          memberFromBalanceToAdd = transfer.amount;
          memberToBalanceToAdd = -transfer.amount;
        } else {
          memberFromBalanceToAdd = -transfer.amount;
          memberToBalanceToAdd = transfer.amount;
        }

        accountMutable.updateIn(['members', memberFrom[0], 'balances', memberFromBalance[0], 'value'],
          updateValue.bind(this, memberFromBalanceToAdd));
        accountMutable.updateIn(['members', memberTo[0], 'balances', memberToBalance[0], 'value'],
          updateValue.bind(this, memberToBalanceToAdd));
      }
    });
  },
  getTransfersForSettlingMembers: function(members, currency) {
    var transfers = [];
    var membersByCurrency = [];

    for (var i = 0; i < members.size; i++) {
      var member = members.get(i);
      var balance = this.getMemberBalance(member, currency);

      if (balance) {
        membersByCurrency.push({
          member: member,
          value: balance.get('value'),
        });
      }
    }

    var resolvedMember = 0;

    function sortASC(a, b) {
      return a.value > b.value;
    }

    while (resolvedMember < membersByCurrency.length) {
      membersByCurrency = membersByCurrency.sort(sortASC);

      var from = membersByCurrency[0];
      var to = membersByCurrency[membersByCurrency.length - 1];

      var amount = (-from.value > to.value) ? to.value : -from.value;

      if (amount === 0) { // Every body is settled
        break;
      }

      from.value += amount;
      to.value -= amount;

      transfers.push({
        from: from.member,
        to: to.member,
        amount: amount,
        currency: currency,
      });

      resolvedMember++;
    }

    return transfers;
  },
  getCurrenciesWithMembers: function(members) {
    var currencies = [];

    for (var i = 0; i < members.size; i++) {
      var member = members.get(i);

      for (var j = 0; j < member.get('balances').size; j++) {
        var currency = member.getIn(['balances', j, 'currency']);
        if (currencies.indexOf(currency) === -1) {
          currencies.push(currency);
        }
      }
    }

    return currencies;
  },
  removeExpenseOfAccount: function(expense, account) {
    var transfers = expenseUtils.getTransfersDueToAnExpense(expense);

    account = this.applyTransfersToAccount(account, transfers, true); // Can lead to a balance with value = 0

    var dateLastExpense = '';
    var currencyUsed = false;

    function removeFromList(index, list) {
      return list.remove(index);
    }

    for (var j = 0; j < account.get('expenses').size; j++) {
      var expenseCurrent = account.getIn(['expenses', j]);
      var id;

      if (typeof expenseCurrent === 'string') {
        id = expenseCurrent;
      } else {
        id = expenseCurrent.get('_id');
      }

      if (id && id === expense.get('_id') || expenseCurrent === expense) { // Remove the expense of the list of expenses
        account = account.update('expenses', removeFromList.bind(this, j));
        j--;
      } else {
        if (expenseCurrent.get('date') > dateLastExpense) { // update the last date expense
          dateLastExpense = expenseCurrent.get('date');
        }

        if (expenseCurrent.get('currency') === expense.get('currency')) {
          currencyUsed = true;
        }
      }
    }

    return account.withMutations(function(accountMutable) {
        // Let's remove the currency form balances of member
        if (!currencyUsed) {
          for (var i = 0; i < accountMutable.get('members').size; i++) {
            var memberBalance = accountUtils.getMemberBalanceEntry(
              accountMutable.getIn(['members', i]),
              expense.get('currency'));

            if (memberBalance) {
              accountMutable.updateIn(['members', i, 'balances'], removeFromList.bind(this, memberBalance[0]));
            }
          }
        }

        accountMutable.set('dateLastExpense', dateLastExpense !== '' ? dateLastExpense : null);
      });
  },
  addExpenseToAccount: function(expense, account) {
    var transfers = expenseUtils.getTransfersDueToAnExpense(expense);

    account = this.applyTransfersToAccount(account, transfers);

    return account.withMutations(function(accountMutable) {
      accountMutable.updateIn(['expenses'], function(list) {
        return list.push(expense);
      });

      accountMutable.set('dateLastExpense', expense.get('date'));
    });
  },

};

module.exports = accountUtils;